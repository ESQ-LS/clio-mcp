import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPatch, clioPost, ClioApiError } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import {
  consumeWritePreviewToken,
  makeWritePreviewToken,
  safeWriteError,
  writeJsonResult,
  writePreviewEnvelope,
} from "../esq/writePreview.js";
import {
  CLIO_CREATE_TOOL_ANNOTATIONS,
  CLIO_READ_ONLY_TOOL_ANNOTATIONS,
  CLIO_UPDATE_TOOL_ANNOTATIONS,
} from "./annotations.js";
import { buildNewCustomFieldValues, buildUpdatedCustomFieldValues } from "../esq/customFieldValues.js";

const MATTER_LIST_FIELDS =
  "id,display_number,description,status,client{id,name},practice_area{id,name},open_date,close_date";

const MATTER_DETAIL_FIELDS =
  "id,etag,display_number,description,status,client{id,name},practice_area{id,name},open_date,close_date,billable," +
  "pending_date,responsible_attorney{id,name},originating_attorney{id,name},responsible_staff{id,name}," +
  "matter_stage{id,name},group{id,name},location,client_reference,updated_at," +
  "relationships{id,description,contact{id,name}},custom_field_values{id,field_name,field_type,value,custom_field{id}}," +
  "statute_of_limitations{status,due_at}";

const matterStatusSchema = z.enum(["open", "pending", "closed"]);
const matterCustomFieldValueSchema = z.object({
  custom_field_id: z.number().int().positive(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
const matterRelationshipSchema = z.object({
  id: z.number().int().positive().optional(),
  contact_id: z.number().int().positive(),
  description: z.string().trim().min(1).max(1000),
});
const matterFieldsSchema = {
  client_id: z.number().int().positive().optional().describe("Clio contact ID of the client"),
  description: z.string().trim().min(1).max(10000).optional().describe("Matter subject / description"),
  practice_area_id: z.number().int().positive().optional().describe("Clio practice area ID"),
  status: matterStatusSchema.optional().describe("Matter status"),
  open_date: z.string().date().optional().describe("Open date (YYYY-MM-DD)"),
  pending_date: z.string().date().optional().describe("Pending date (YYYY-MM-DD)"),
  close_date: z.string().date().optional().describe("Close date (YYYY-MM-DD)"),
  billable: z.boolean().optional().describe("Whether this matter is billable"),
  responsible_attorney_id: z.number().int().positive().optional().describe("Clio user ID of the responsible attorney"),
  originating_attorney_id: z.number().int().positive().optional().describe("Clio user ID of the originating attorney"),
  responsible_staff_id: z.number().int().positive().optional().describe("Clio user ID of responsible staff"),
  matter_stage_id: z.number().int().positive().optional().describe("Clio matter stage ID"),
  group_id: z.number().int().positive().optional().describe("Clio group ID"),
  location: z.string().trim().max(500).optional().describe("Matter location"),
  client_reference: z.string().trim().max(255).optional().describe("External reference for cross-linking systems"),
  display_number: z.string().trim().min(1).max(255).optional().describe("Manual matter number; only accepted when the Clio account permits it"),
  require_utbms_codes: z.boolean().optional(),
  custom_field_values: z.array(matterCustomFieldValueSchema).max(100).optional(),
  statute_of_limitations_due_at: z.string().date().optional(),
  statute_of_limitations_status: z.enum(["pending", "in_progress", "in_review", "complete", "draft"]).optional(),
  relationships: z.array(matterRelationshipSchema).max(50).optional(),
};

function buildMatterData(input: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of [
    "description", "display_number", "status", "open_date", "pending_date", "close_date", "billable",
    "location", "client_reference", "require_utbms_codes",
  ] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  for (const [inputKey, apiKey] of [
    ["client_id", "client"],
    ["practice_area_id", "practice_area"],
    ["responsible_attorney_id", "responsible_attorney"],
    ["originating_attorney_id", "originating_attorney"],
    ["responsible_staff_id", "responsible_staff"],
    ["matter_stage_id", "matter_stage"],
    ["group_id", "group"],
  ] as const) {
    if (input[inputKey] !== undefined) data[apiKey] = { id: input[inputKey] };
  }
  if (input.custom_field_values !== undefined) {
    data.custom_field_values = buildNewCustomFieldValues(input.custom_field_values);
  }
  if (input.statute_of_limitations_due_at !== undefined || input.statute_of_limitations_status !== undefined) {
    data.statute_of_limitations = {
      ...(input.statute_of_limitations_due_at !== undefined && { due_at: input.statute_of_limitations_due_at }),
      ...(input.statute_of_limitations_status !== undefined && { status: input.statute_of_limitations_status }),
    };
  }
  if (input.relationships !== undefined) {
    data.relationships = (input.relationships as Array<{ id?: number; contact_id: number; description: string }>).map(
      ({ id, contact_id, description }) => ({ ...(id !== undefined && { id }), contact: { id: contact_id }, description }),
    );
  }
  return data;
}

function buildMatterUpdateData(input: Record<string, unknown>, current: any): Record<string, unknown> {
  const data = buildMatterData(input);
  if (input.custom_field_values !== undefined) {
    data.custom_field_values = buildUpdatedCustomFieldValues(
      input.custom_field_values,
      current.custom_field_values,
    );
  }
  return data;
}

async function resolveMatterReferences(input: Record<string, unknown>) {
  const refs: Record<string, unknown> = {};
  if (input.client_id !== undefined) {
    const response = await clioGet(`/contacts/${input.client_id}.json`, { fields: "id,name,type" });
    if (response?.data?.id !== input.client_id) throw new Error("Client validation failed.");
    refs.client = { id: response.data.id, name: response.data.name, type: response.data.type };
  }
  if (input.practice_area_id !== undefined) {
    const response = await clioGet(`/practice_areas/${input.practice_area_id}.json`, { fields: "id,name" });
    if (response?.data?.id !== input.practice_area_id) throw new Error("Practice-area validation failed.");
    refs.practice_area = { id: response.data.id, name: response.data.name };
  }
  for (const [inputKey, outputKey] of [
    ["responsible_attorney_id", "responsible_attorney"],
    ["originating_attorney_id", "originating_attorney"],
    ["responsible_staff_id", "responsible_staff"],
  ] as const) {
    if (input[inputKey] !== undefined) {
      const response = await clioGet(`/users/${input[inputKey]}.json`, { fields: "id,name,enabled" });
      if (response?.data?.id !== input[inputKey] || response.data.enabled === false) throw new Error(`${outputKey} validation failed.`);
      refs[outputKey] = { id: response.data.id, name: response.data.name };
    }
  }
  if (input.matter_stage_id !== undefined) {
    const response = await clioGet(`/matter_stages/${input.matter_stage_id}.json`, { fields: "id,name" });
    if (response?.data?.id !== input.matter_stage_id) throw new Error("Matter-stage validation failed.");
    refs.matter_stage = { id: response.data.id, name: response.data.name };
  }
  if (input.group_id !== undefined) {
    const response = await clioGet(`/groups/${input.group_id}.json`, { fields: "id,name" });
    if (response?.data?.id !== input.group_id) throw new Error("Group validation failed.");
    refs.group = { id: response.data.id, name: response.data.name };
  }
  if (input.relationships !== undefined) {
    const validated = [];
    for (const relationship of input.relationships as Array<{ contact_id: number; description: string }>) {
      const response = await clioGet(`/contacts/${relationship.contact_id}.json`, { fields: "id,name,type" });
      if (response?.data?.id !== relationship.contact_id) throw new Error(`Related contact ${relationship.contact_id} validation failed.`);
      validated.push({ contact: { id: response.data.id, name: response.data.name, type: response.data.type }, description: relationship.description });
    }
    refs.relationships = validated;
  }
  return refs;
}

async function recordMatterMutation(
  tool: "create_matter" | "update_matter",
  confirmationState: "dry_run" | "confirmed",
  outcome: "success" | "error",
  fieldsChanged: string[],
  matterId?: number,
  errorMessage?: string,
): Promise<boolean> {
  return appendAuditLog({
    tool,
    action: tool === "create_matter" ? "create" : "update",
    confirmation_state: confirmationState,
    outcome,
    ...(matterId !== undefined && { matter_id: matterId, record_id: matterId }),
    ...(errorMessage !== undefined && { error_message: errorMessage }),
    args: { confirm_write: confirmationState === "confirmed", fields_changed: fieldsChanged },
  });
}

export function registerMatterTools(server: McpServer): void {
  server.registerTool(
    "list_matters",
    {
      description: "List matters from the connected Clio account",
      inputSchema: {
        status: z.enum(["open", "pending", "closed"]).optional().describe("Filter by matter status"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ status, limit }) => {
      try {
        const params: Record<string, string> = {
          fields: MATTER_LIST_FIELDS,
          limit: String(limit),
        };
        if (status) params["status"] = status;

        const data = await clioGet("/matters.json", params);
        const matters = data.data as any[];

        await appendAuditLog({ tool: "list_matters", args: { status, limit }, outcome: "success", result_count: matters?.length ?? 0 });

        if (!matters || matters.length === 0) {
          return { content: [{ type: "text", text: "No matters found." }] };
        }

        const result = matters.map((m) => ({
          id: m.id,
          display_number: m.display_number,
          description: m.description,
          status: m.status,
          client: m.client?.name ?? null,
          practice_area: m.practice_area?.name ?? null,
          open_date: m.open_date,
          close_date: m.close_date ?? null,
          pending_date: m.pending_date ?? null,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        await appendAuditLog({ tool: "list_matters", args: { status, limit }, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_matter",
    {
      description: "Get full detail for a single matter by ID",
      inputSchema: {
        matter_id: z.number().int().describe("The Clio matter ID"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ matter_id }) => {
      try {
        const data = await clioGet(`/matters/${matter_id}.json`, { fields: MATTER_DETAIL_FIELDS });
        const m = data.data;

        const result = {
          id: m.id,
          etag: m.etag ?? null,
          display_number: m.display_number,
          description: m.description,
          status: m.status,
          client: m.client ? { id: m.client.id, name: m.client.name } : null,
          practice_area: m.practice_area ? { id: m.practice_area.id, name: m.practice_area.name } : null,
          open_date: m.open_date,
          close_date: m.close_date ?? null,
          billable: m.billable,
          responsible_attorney: m.responsible_attorney
            ? { id: m.responsible_attorney.id, name: m.responsible_attorney.name }
            : null,
          originating_attorney: m.originating_attorney
            ? { id: m.originating_attorney.id, name: m.originating_attorney.name }
            : null,
          responsible_staff: m.responsible_staff
            ? { id: m.responsible_staff.id, name: m.responsible_staff.name }
            : null,
          matter_stage: m.matter_stage ? { id: m.matter_stage.id, name: m.matter_stage.name } : null,
          group: m.group ? { id: m.group.id, name: m.group.name } : null,
          location: m.location ?? null,
          client_reference: m.client_reference ?? null,
          custom_field_values: m.custom_field_values ?? [],
          statute_of_limitations: m.statute_of_limitations ?? null,
          relationships: m.relationships ?? [],
          updated_at: m.updated_at,
        };

        await appendAuditLog({ tool: "get_matter", args: { matter_id }, outcome: "success", matter_id });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_matter", args: { matter_id }, outcome: "success", matter_id });
          return { content: [{ type: "text", text: `Matter ${matter_id} not found.` }] };
        }
        await appendAuditLog({ tool: "get_matter", args: { matter_id }, outcome: "error", error_message: err.message, matter_id });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "create_matter",
    {
      title: "Create a controlled Clio matter",
      description:
        "Dry-run by default. Validates referenced Clio records and displays the exact proposed matter. A production write requires confirm_write: true plus the unexpired preview_token from an unchanged dry-run proposal.",
      inputSchema: {
        client_id: z.number().int().positive().describe("Clio contact ID of the client for this matter"),
        description: z.string().trim().min(1).max(10000).describe("Matter subject / description"),
        practice_area_id: matterFieldsSchema.practice_area_id,
        status: matterStatusSchema.default("pending").describe("Initial status; defaults to pending for intake"),
        open_date: matterFieldsSchema.open_date,
        pending_date: matterFieldsSchema.pending_date,
        billable: z.boolean().default(true),
        responsible_attorney_id: matterFieldsSchema.responsible_attorney_id,
        originating_attorney_id: matterFieldsSchema.originating_attorney_id,
        responsible_staff_id: matterFieldsSchema.responsible_staff_id,
        matter_stage_id: matterFieldsSchema.matter_stage_id,
        group_id: matterFieldsSchema.group_id,
        location: matterFieldsSchema.location,
        client_reference: matterFieldsSchema.client_reference,
        display_number: matterFieldsSchema.display_number,
        require_utbms_codes: matterFieldsSchema.require_utbms_codes,
        custom_field_values: matterFieldsSchema.custom_field_values,
        statute_of_limitations_due_at: matterFieldsSchema.statute_of_limitations_due_at,
        statute_of_limitations_status: matterFieldsSchema.statute_of_limitations_status,
        relationships: matterFieldsSchema.relationships,
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async (input) => {
      const confirmationState = input.confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      const today = new Date().toISOString().slice(0, 10);
      const normalized = { ...input, open_date: input.open_date ?? today };
      const data = buildMatterData(normalized);
      const fieldsChanged = Object.keys(data);
      try {
        const references = await resolveMatterReferences(normalized);
        const proposal = { ...data, ...references };
        if (!input.confirm_write) {
          const auditOk = await recordMatterMutation("create_matter", "dry_run", "success", fieldsChanged);
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_matter", proposal, await makeWritePreviewToken("create_matter", proposal),
          ));
        }

        if (!input.preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(input.preview_token, "create_matter", proposal);
        const preWriteAuditOk = await recordMatterMutation("create_matter", "confirmed", "success", fieldsChanged);
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const response = await clioPost("/matters.json", { data });
        if (!response?.data?.id) throw new Error("Clio returned an invalid create response.");
        const auditOk = await recordMatterMutation(
          "create_matter", "confirmed", "success", fieldsChanged, response.data.id,
        );
        return writeJsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "create_matter",
          record_id: response.data.id,
          audit_recorded: auditOk,
          matter: response.data,
        });
      } catch (error) {
        const message = safeWriteError(error);
        await recordMatterMutation("create_matter", confirmationState, "error", fieldsChanged, undefined, message);
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Search Clio for the proposed matter before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    },
  );

  server.registerTool(
    "update_matter",
    {
      title: "Update a controlled Clio matter",
      description:
        "Dry-run by default. Reads the current matter, validates references, and displays the exact proposed changes. A production write requires confirm_write: true plus the unexpired preview_token; the token is invalidated if the matter changes before confirmation.",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Exact Clio matter ID"),
        ...matterFieldsSchema,
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_UPDATE_TOOL_ANNOTATIONS,
    },
    async (input) => {
      const confirmationState = input.confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      let data = buildMatterData(input);
      const fieldsChanged = Object.keys(data);
      try {
        if (fieldsChanged.length === 0) throw new Error("At least one matter field must be supplied.");
        const currentResponse = await clioGet(`/matters/${input.matter_id}.json`, {
          fields: MATTER_DETAIL_FIELDS,
        });
        const current = currentResponse?.data;
        if (current?.id !== input.matter_id) throw new Error("Matter validation failed.");
        if (typeof current.etag !== "string" || !current.etag.trim()) {
          throw new Error("Clio did not return a matter ETag; no update can be performed safely.");
        }
        data = buildMatterUpdateData(input, current);
        const references = await resolveMatterReferences(input);
        const proposal = {
          record_id: input.matter_id,
          current_etag: current.etag,
          current_updated_at: current.updated_at,
          current: {
            display_number: current.display_number,
            description: current.description,
            status: current.status,
            client: current.client,
          },
          changes: { ...data, ...references },
          fields_changed: fieldsChanged,
        };

        if (!input.confirm_write) {
          const auditOk = await recordMatterMutation(
            "update_matter", "dry_run", "success", fieldsChanged, input.matter_id,
          );
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "update_matter", proposal, await makeWritePreviewToken("update_matter", proposal),
          ));
        }

        if (!input.preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(input.preview_token, "update_matter", proposal);
        const preWriteAuditOk = await recordMatterMutation(
          "update_matter", "confirmed", "success", fieldsChanged, input.matter_id,
        );
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const response = await clioPatch(`/matters/${input.matter_id}.json`, { data }, { "If-Match": current.etag });
        if (!response?.data?.id) throw new Error("Clio returned an invalid update response.");
        const auditOk = await recordMatterMutation(
          "update_matter", "confirmed", "success", fieldsChanged, input.matter_id,
        );
        return writeJsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "update_matter",
          record_id: input.matter_id,
          audit_recorded: auditOk,
          matter: response.data,
        });
      } catch (error) {
        const message = safeWriteError(error);
        await recordMatterMutation(
          "update_matter", confirmationState, "error", fieldsChanged, input.matter_id, message,
        );
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Retrieve the current Clio matter before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    },
  );
}
