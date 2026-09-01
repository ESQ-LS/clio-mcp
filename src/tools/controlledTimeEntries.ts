import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { appendAuditLog } from "../utils/auditLog.js";
import { ClioApiError, clioGet, clioPatch, clioPost } from "../utils/clioClient.js";
import {
  CLIO_CREATE_TOOL_ANNOTATIONS,
  CLIO_UPDATE_TOOL_ANNOTATIONS,
} from "./annotations.js";

const PREVIEW_TTL_MS = 15 * 60 * 1000;

const TIME_ENTRY_FIELDS =
  "id,etag,type,date,quantity_in_hours,rounded_quantity_in_hours,price,total,note," +
  "billed,on_bill,non_billable,no_charge,created_at,updated_at," +
  "activity_description{id,name},matter{id,display_number},user{id,name}";

const MATTER_FIELDS = "id,display_number,status,billable,billing_method,require_utbms_codes";
const USER_FIELDS = "id,name,enabled,subscription_type,rate";
const ACTIVITY_DESCRIPTION_FIELDS = "id,name,default,rate";

type BillingStatus = "billable" | "non_billable";
type Action = "create" | "update";

interface PreviewClaims {
  version: 1;
  action: Action;
  fingerprint: string;
  issued_at: number;
  nonce: string;
}

const consumedPreviewNonces = new Map<string, number>();

interface ValidatedReference {
  matter: any;
  user: any;
  activityDescription: any;
}

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError && { isError: true }),
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ClioApiError) return `Clio API request failed with status ${error.statusCode}`;
  return "Clio API request failed";
}

function previewSecret(): Buffer {
  const value = process.env.ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("Server configuration error: ENCRYPTION_KEY is required for write-preview tokens.");
  }
  return createHmac("sha256", value).update("esq-clio-controlled-time-entry-preview-v1").digest();
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function makePreviewToken(action: Action, proposal: unknown, now = Date.now()): string {
  const claims: PreviewClaims = {
    version: 1,
    action,
    fingerprint: fingerprint(proposal),
    issued_at: now,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", previewSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function consumePreviewToken(token: string, action: Action, proposal: unknown, now = Date.now()): void {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) throw new Error("Invalid preview token.");
  const expectedSignature = createHmac("sha256", previewSecret()).update(payload).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Invalid preview token.");
  }
  let claims: PreviewClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid preview token.");
  }
  if (claims.version !== 1 || claims.action !== action || claims.fingerprint !== fingerprint(proposal)) {
    throw new Error("The proposal changed after preview. Run a new dry-run before confirming.");
  }
  if (!Number.isFinite(claims.issued_at) || claims.issued_at > now || now - claims.issued_at > PREVIEW_TTL_MS) {
    throw new Error("The preview token expired. Run a new dry-run before confirming.");
  }
  if (!claims.nonce || consumedPreviewNonces.has(claims.nonce)) {
    throw new Error("This preview token has already been used. Run a new dry-run before confirming another write.");
  }
  for (const [nonce, consumedAt] of consumedPreviewNonces) {
    if (now - consumedAt > PREVIEW_TTL_MS) consumedPreviewNonces.delete(nonce);
  }
  consumedPreviewNonces.set(claims.nonce, now);
}

function billingStatus(entry: any): BillingStatus {
  return entry.non_billable ? "non_billable" : "billable";
}

function assertMutableTimeEntry(entry: any, expectedEtag: string): void {
  if (!entry || entry.type !== "TimeEntry") throw new Error("The requested activity is not a time entry.");
  if (entry.billed || entry.on_bill) throw new Error("Billed or invoiced time entries cannot be updated.");
  if (!entry.etag || entry.etag !== expectedEtag) {
    throw new Error("The time entry changed after it was retrieved. Fetch the current entry and preview again.");
  }
  if (entry.quantity_in_hours === null || entry.quantity_in_hours === undefined) {
    throw new Error("The authenticated Clio user cannot view this entry's hours, so it cannot be updated safely.");
  }
}

async function validateReferences(
  matterId: number,
  userId: number,
  activityDescriptionId: number | null,
  proposedBillingStatus: BillingStatus,
): Promise<ValidatedReference> {
  const matterResponse = await clioGet(`/matters/${matterId}.json`, { fields: MATTER_FIELDS });
  const matter = matterResponse?.data;
  if (!matter || matter.id !== matterId) throw new Error("Matter validation failed.");
  if (String(matter.status ?? "").toLowerCase() === "closed") throw new Error("Closed matters cannot receive new time-entry writes.");
  if (proposedBillingStatus === "billable" && matter.billable === false) {
    throw new Error("A billable time entry cannot be written to a non-billable matter.");
  }
  if (proposedBillingStatus === "billable" && matter.require_utbms_codes === true) {
    throw new Error("This matter requires UTBMS codes, which this controlled tool does not accept.");
  }

  const userResponse = await clioGet(`/users/${userId}.json`, { fields: USER_FIELDS });
  const user = userResponse?.data;
  if (!user || user.id !== userId || user.enabled === false) throw new Error("Lawyer validation failed.");

  let activityDescription: any = null;
  if (activityDescriptionId !== null) {
    const activityResponse = await clioGet(`/activity_descriptions/${activityDescriptionId}.json`, {
      fields: ACTIVITY_DESCRIPTION_FIELDS,
    });
    activityDescription = activityResponse?.data;
    if (!activityDescription || activityDescription.id !== activityDescriptionId) {
      throw new Error("Activity-description validation failed.");
    }
  }
  return { matter, user, activityDescription };
}

async function recordMutationAudit(entry: {
  tool: "create_time_entry" | "update_time_entry";
  action: Action;
  confirmation_state: "dry_run" | "confirmed";
  outcome: "success" | "error";
  matter_id: number;
  record_id?: number;
  error_message?: string;
  fields_changed?: string[];
}): Promise<boolean> {
  return appendAuditLog({
    tool: entry.tool,
    action: entry.action,
    confirmation_state: entry.confirmation_state,
    outcome: entry.outcome,
    matter_id: entry.matter_id,
    ...(entry.record_id !== undefined && { record_id: entry.record_id }),
    ...(entry.error_message !== undefined && { error_message: entry.error_message }),
    args: {
      confirm_write: entry.confirmation_state === "confirmed",
      ...(entry.fields_changed && { fields_changed: entry.fields_changed }),
    },
  });
}

function previewEnvelope(action: Action, proposal: any, previewToken: string) {
  return {
    mode: "dry_run",
    write_performed: false,
    action,
    proposal,
    preview_token: previewToken,
    preview_expires_in_minutes: PREVIEW_TTL_MS / 60000,
    next_step:
      "Review every displayed field. To perform this exact mutation, call the same tool with unchanged inputs, confirm_write: true, and this preview_token.",
  };
}

export function registerControlledTimeEntryTools(server: McpServer): void {
  server.registerTool(
    "create_time_entry",
    {
      title: "Create a controlled Clio time entry",
      description:
        "Dry-run by default. Validates and displays the exact proposed Clio time entry. A production write requires confirm_write: true plus the unexpired preview_token from an unchanged dry-run proposal.",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Exact Clio matter ID"),
        date: z.string().date().describe("ISO date (YYYY-MM-DD) when the work was performed"),
        user_id: z.number().int().positive().describe("Exact Clio user ID for the lawyer who performed the work"),
        quantity_in_hours: z.number().positive().max(24).describe("Supported duration in hours"),
        rate: z.number().nonnegative().max(10000).describe("Explicit hourly rate to write and display"),
        billing_status: z.enum(["billable", "non_billable"]).default("billable"),
        narrative: z.string().trim().min(5).max(2000).describe("Evidence-backed billing narrative"),
        activity_description_id: z.number().int().positive().describe("Validated Clio activity description ID"),
        supporting_evidence: z.string().trim().min(5).max(2000).describe("Identified source supporting the date, work and duration; never written to Clio or the audit log"),
        confirm_write: z.boolean().default(false).describe("Must be true for a production write; false returns a dry-run preview"),
        preview_token: z.string().optional().describe("Unexpired token returned by the unchanged dry-run preview"),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, date, user_id, quantity_in_hours, rate, billing_status, narrative, activity_description_id, supporting_evidence, confirm_write, preview_token }) => {
      const confirmationState = confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      try {
        const refs = await validateReferences(matter_id, user_id, activity_description_id, billing_status);
        const proposal = {
          matter: { id: refs.matter.id, display_number: refs.matter.display_number },
          date,
          lawyer: { id: refs.user.id, name: refs.user.name },
          duration_hours: quantity_in_hours,
          rate,
          billing_status,
          narrative,
          activity_description: { id: refs.activityDescription.id, name: refs.activityDescription.name },
          supporting_evidence,
          clio_reference_rates: {
            lawyer_rate: refs.user.rate ?? null,
            activity_description_rate: refs.activityDescription.rate ?? null,
          },
        };

        if (!confirm_write) {
          const auditOk = await recordMutationAudit({
            tool: "create_time_entry", action: "create", confirmation_state: "dry_run", outcome: "success", matter_id,
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return jsonResult(previewEnvelope("create", proposal, makePreviewToken("create", proposal)));
        }

        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        consumePreviewToken(preview_token, "create", proposal);
        const preWriteAuditOk = await recordMutationAudit({
          tool: "create_time_entry", action: "create", confirmation_state: "confirmed", outcome: "success", matter_id,
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");

        const payload = {
          data: {
            type: "TimeEntry",
            date,
            quantity: quantity_in_hours * 3600,
            price: rate,
            note: narrative,
            non_billable: billing_status === "non_billable",
            matter: { id: matter_id },
            user: { id: user_id },
            activity_description: { id: activity_description_id },
          },
        };
        writeAttempted = true;
        const response = await clioPost("/activities.json", payload);
        const entry = response?.data;
        if (!entry?.id) throw new Error("Clio returned an invalid create response.");
        const finalAuditOk = await recordMutationAudit({
          tool: "create_time_entry", action: "create", confirmation_state: "confirmed", outcome: "success",
          matter_id, record_id: entry.id,
        });
        return jsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "create",
          record_id: entry.id,
          audit_recorded: finalAuditOk,
          etag: entry.etag ?? null,
          time_entry: {
            matter: entry.matter ?? proposal.matter,
            date: entry.date ?? date,
            lawyer: entry.user ?? proposal.lawyer,
            duration_hours: entry.quantity_in_hours ?? quantity_in_hours,
            rate: entry.price ?? rate,
            billing_status: billingStatus(entry),
            narrative: entry.note ?? narrative,
            activity_description: entry.activity_description ?? proposal.activity_description,
          },
        });
      } catch (error) {
        await recordMutationAudit({
          tool: "create_time_entry", action: "create", confirmation_state: confirmationState, outcome: "error",
          matter_id, error_message: error instanceof Error && !error.message.startsWith("Clio API error") ? error.message : safeErrorMessage(error),
        });
        return jsonResult({
          error: error instanceof Error ? error.message : "Unknown error",
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Verify the proposed entry in Clio before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    },
  );

  server.registerTool(
    "update_time_entry",
    {
      title: "Update a controlled unbilled Clio time entry",
      description:
        "Dry-run by default. Updates only an exact unbilled TimeEntry and requires its current ETag. A production write requires confirm_write: true plus the unexpired preview_token from an unchanged dry-run proposal.",
      inputSchema: {
        activity_id: z.number().int().positive().describe("Exact Clio Activity ID"),
        etag: z.string().min(3).describe("Current ETag from get_time_entry"),
        date: z.string().date().optional(),
        user_id: z.number().int().positive().optional(),
        quantity_in_hours: z.number().positive().max(24).optional(),
        rate: z.number().nonnegative().max(10000).optional(),
        narrative: z.string().trim().min(5).max(2000).optional(),
        activity_description_id: z.number().int().positive().optional(),
        supporting_evidence: z.string().trim().min(5).max(2000).describe("Identified source supporting the proposed edit; never written to Clio or the audit log"),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_UPDATE_TOOL_ANNOTATIONS,
    },
    async ({ activity_id, etag, date, user_id, quantity_in_hours, rate, narrative, activity_description_id, supporting_evidence, confirm_write, preview_token }) => {
      const confirmationState = confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      let matterId = 0;
      const fieldsChanged = [
        date !== undefined && "date",
        user_id !== undefined && "lawyer",
        quantity_in_hours !== undefined && "duration_hours",
        rate !== undefined && "rate",
        narrative !== undefined && "narrative",
        activity_description_id !== undefined && "activity_description",
      ].filter(Boolean) as string[];
      try {
        if (fieldsChanged.length === 0) throw new Error("At least one editable field must be supplied.");
        if ((user_id !== undefined || activity_description_id !== undefined) && rate === undefined) {
          throw new Error("An explicit rate is required when changing the lawyer or activity description.");
        }
        const currentResponse = await clioGet(`/activities/${activity_id}.json`, { fields: TIME_ENTRY_FIELDS });
        const current = currentResponse?.data;
        assertMutableTimeEntry(current, etag);
        matterId = current.matter?.id;
        if (!matterId || !current.user?.id || current.price === null || current.price === undefined) {
          throw new Error("The current time entry is missing matter, lawyer or rate data required for a safe update.");
        }
        const nextUserId = user_id ?? current.user.id;
        const nextActivityDescriptionId = activity_description_id ?? current.activity_description?.id ?? null;
        const currentBillingStatus = billingStatus(current);
        const refs = await validateReferences(matterId, nextUserId, nextActivityDescriptionId, currentBillingStatus);
        const proposal = {
          record_id: activity_id,
          current_etag: etag,
          matter: { id: refs.matter.id, display_number: refs.matter.display_number },
          date: date ?? current.date,
          lawyer: { id: refs.user.id, name: refs.user.name },
          duration_hours: quantity_in_hours ?? current.quantity_in_hours,
          rate: rate ?? current.price,
          billing_status: currentBillingStatus,
          narrative: narrative ?? current.note ?? "",
          activity_description: refs.activityDescription
            ? { id: refs.activityDescription.id, name: refs.activityDescription.name }
            : null,
          supporting_evidence,
          fields_changed: fieldsChanged,
          clio_reference_rates: {
            lawyer_rate: refs.user.rate ?? null,
            activity_description_rate: refs.activityDescription?.rate ?? null,
          },
        };

        if (!confirm_write) {
          const auditOk = await recordMutationAudit({
            tool: "update_time_entry", action: "update", confirmation_state: "dry_run", outcome: "success",
            matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return jsonResult(previewEnvelope("update", proposal, makePreviewToken("update", proposal)));
        }

        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        consumePreviewToken(preview_token, "update", proposal);
        const preWriteAuditOk = await recordMutationAudit({
          tool: "update_time_entry", action: "update", confirmation_state: "confirmed", outcome: "success",
          matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");

        const data: Record<string, unknown> = {};
        if (date !== undefined) data.date = date;
        if (user_id !== undefined) data.user = { id: user_id };
        if (quantity_in_hours !== undefined) data.quantity = quantity_in_hours * 3600;
        if (rate !== undefined) data.price = rate;
        if (narrative !== undefined) data.note = narrative;
        if (activity_description_id !== undefined) data.activity_description = { id: activity_description_id };
        writeAttempted = true;
        const response = await clioPatch(`/activities/${activity_id}.json`, { data }, { "If-Match": etag });
        const entry = response?.data;
        if (!entry?.id) throw new Error("Clio returned an invalid update response.");
        const finalAuditOk = await recordMutationAudit({
          tool: "update_time_entry", action: "update", confirmation_state: "confirmed", outcome: "success",
          matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
        });
        return jsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "update",
          record_id: activity_id,
          audit_recorded: finalAuditOk,
          previous_etag: etag,
          etag: entry.etag ?? null,
          time_entry: {
            matter: entry.matter ?? proposal.matter,
            date: entry.date ?? proposal.date,
            lawyer: entry.user ?? proposal.lawyer,
            duration_hours: entry.quantity_in_hours ?? proposal.duration_hours,
            rate: entry.price ?? proposal.rate,
            billing_status: billingStatus(entry),
            narrative: entry.note ?? proposal.narrative,
            activity_description: entry.activity_description ?? proposal.activity_description,
          },
        });
      } catch (error) {
        await recordMutationAudit({
          tool: "update_time_entry", action: "update", confirmation_state: confirmationState, outcome: "error",
          matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
          error_message: error instanceof Error && !error.message.startsWith("Clio API error") ? error.message : safeErrorMessage(error),
        });
        return jsonResult({
          error: error instanceof Error ? error.message : "Unknown error",
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Retrieve the current Clio activity before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    },
  );
}
