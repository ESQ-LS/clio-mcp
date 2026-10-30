import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import {
  consumeWritePreviewToken,
  makeWritePreviewToken,
  safeWriteError,
  writeJsonResult,
  writePreviewEnvelope,
} from "../esq/writePreview.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { clioGet, clioPatch, clioPost, extractNextPageToken } from "../utils/clioClient.js";
import {
  CLIO_CREATE_TOOL_ANNOTATIONS,
  CLIO_READ_ONLY_TOOL_ANNOTATIONS,
  CLIO_UPDATE_TOOL_ANNOTATIONS,
} from "./annotations.js";

const EXPENSE_FIELDS =
  "id,etag,type,date,quantity,price,total,note,billed,on_bill,non_billable,no_charge," +
  "tax_setting,tax_settings,created_at,updated_at,expense_category{id,name,entry_type}," +
  "matter{id,display_number}";
const MATTER_FIELDS = "id,display_number,status,billable,billing_method,require_utbms_codes,redacted";
const EXPENSE_CATEGORY_FIELDS =
  "id,name,entry_type,rate,tax_setting,tax_settings,accessible_to_user,redacted";
const SOURCE_REFERENCE_PREFIX = "Source reference: ";
const MAX_DUPLICATE_SCAN_PAGES = 5;

type BillingStatus = "billable" | "non_billable" | "no_charge";
type CostType =
  | "client_recoverable_direct_cost"
  | "third_party_fee_recovery"
  | "internal_non_billable_cost";
type TaxSetting = "no_tax" | "tax_1_only" | "tax_2_only" | "tax_1_and_tax_2";
type Action = "create" | "update";

interface ExpenseCandidate {
  matter_id: number;
  date: string;
  amount: number;
  expense_category_id: number;
  description: string;
  source_reference: string;
  billing_status: BillingStatus;
  tax_setting: TaxSetting;
  cost_type: CostType;
}

function billingFlags(status: BillingStatus): { non_billable: boolean; no_charge: boolean } {
  return {
    non_billable: status !== "billable",
    no_charge: status === "no_charge",
  };
}

function billingStatus(entry: any): BillingStatus {
  if (entry?.no_charge) return "no_charge";
  return entry?.non_billable ? "non_billable" : "billable";
}

function composeExpenseNote(description: string, sourceReference: string): string {
  return `${description}\n\n${SOURCE_REFERENCE_PREFIX}${sourceReference}`;
}

function parseExpenseNote(note: unknown): { description: string; source_reference: string | null } {
  const value = String(note ?? "");
  const markerIndex = value.lastIndexOf(`\n\n${SOURCE_REFERENCE_PREFIX}`);
  if (markerIndex < 0) return { description: value, source_reference: null };
  return {
    description: value.slice(0, markerIndex),
    source_reference: value.slice(markerIndex + 2 + SOURCE_REFERENCE_PREFIX.length),
  };
}

function normalizeSourceReference(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-CA");
}

function expenseSummary(entry: any) {
  const parsedNote = parseExpenseNote(entry.note);
  return {
    id: entry.id,
    etag: entry.etag ?? null,
    type: entry.type,
    date: entry.date,
    quantity: entry.quantity ?? null,
    amount: entry.price ?? null,
    total: entry.total ?? null,
    description: parsedNote.description || null,
    source_reference: parsedNote.source_reference,
    billing_status: billingStatus(entry),
    billed: entry.billed ?? null,
    on_bill: entry.on_bill ?? null,
    tax_setting: entry.tax_setting ?? null,
    tax_settings: entry.tax_settings ?? null,
    expense_category: entry.expense_category
      ? {
          id: entry.expense_category.id,
          name: entry.expense_category.name,
          entry_type: entry.expense_category.entry_type ?? null,
        }
      : null,
    matter: entry.matter
      ? { id: entry.matter.id, display_number: entry.matter.display_number }
      : null,
    created_at: entry.created_at ?? null,
    updated_at: entry.updated_at ?? null,
  };
}

async function validateExpenseReferences(candidate: ExpenseCandidate): Promise<{ matter: any; category: any }> {
  if (candidate.cost_type === "internal_non_billable_cost" && candidate.billing_status === "billable") {
    throw new Error("Internal firm costs cannot be marked billable by this controlled tool.");
  }

  const matterResponse = await clioGet(`/matters/${candidate.matter_id}.json`, {
    fields: MATTER_FIELDS,
  });
  const matter = matterResponse?.data;
  if (!matter || matter.id !== candidate.matter_id) throw new Error("Matter validation failed.");
  if (matter.redacted === true) {
    throw new Error("Matter validation failed because the authenticated user cannot access the full matter.");
  }
  if (String(matter.status ?? "").toLowerCase() === "closed") {
    throw new Error("Closed matters cannot receive new expense-entry writes.");
  }
  if (candidate.billing_status === "billable" && matter.billable === false) {
    throw new Error("A billable expense cannot be written to a non-billable matter.");
  }
  if (candidate.billing_status === "billable" && matter.require_utbms_codes === true) {
    throw new Error("This matter requires a UTBMS expense code, which this controlled tool does not accept.");
  }

  const categoryResponse = await clioGet(`/expense_categories/${candidate.expense_category_id}.json`, {
    fields: EXPENSE_CATEGORY_FIELDS,
  });
  const category = categoryResponse?.data;
  if (!category || category.id !== candidate.expense_category_id) {
    throw new Error("Expense-category validation failed.");
  }
  if (category.redacted === true || category.accessible_to_user === false) {
    throw new Error("Expense-category validation failed because the category is not accessible to the authenticated user.");
  }
  if (category.entry_type !== "unassociated") {
    throw new Error("Only unassociated expense categories can be used with an ExpenseEntry.");
  }
  return { matter, category };
}

async function findDuplicateExpense(candidate: ExpenseCandidate, excludeId?: number): Promise<any | null> {
  const expectedSourceReference = normalizeSourceReference(candidate.source_reference);
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_DUPLICATE_SCAN_PAGES; page++) {
    const params: Record<string, string> = {
      fields: EXPENSE_FIELDS,
      type: "ExpenseEntry",
      matter_id: String(candidate.matter_id),
      expense_category_id: String(candidate.expense_category_id),
      start_date: candidate.date,
      end_date: candidate.date,
      query: candidate.source_reference,
      limit: "200",
    };
    if (pageToken) params.page_token = pageToken;
    const response = await clioGet("/activities.json", params);
    const entries = Array.isArray(response?.data) ? response.data : [];
    const duplicate = entries.find((entry: any) =>
      entry.id !== excludeId &&
      entry.type === "ExpenseEntry" &&
      entry.matter?.id === candidate.matter_id &&
      entry.expense_category?.id === candidate.expense_category_id &&
      entry.date === candidate.date &&
      Number(entry.price) === candidate.amount &&
      normalizeSourceReference(parseExpenseNote(entry.note).source_reference) === expectedSourceReference,
    );
    if (duplicate) return duplicate;
    pageToken = extractNextPageToken(response?.meta);
    if (!pageToken) return null;
  }
  throw new Error("Duplicate screening exceeded 1,000 matching activities; narrow the source reference before writing.");
}

function assertMutableExpense(entry: any, expectedEtag: string): void {
  if (!entry || entry.type !== "ExpenseEntry") {
    throw new Error("The requested activity is not an ExpenseEntry.");
  }
  if (entry.billed || entry.on_bill) {
    throw new Error("Billed or invoiced expense entries cannot be updated.");
  }
  if (!entry.etag || entry.etag !== expectedEtag) {
    throw new Error("The expense entry changed after it was retrieved. Fetch the current entry and preview again.");
  }
  if (!entry.matter?.id || !entry.expense_category?.id || entry.price === null || entry.price === undefined) {
    throw new Error("The current expense entry is missing matter, category, or amount data required for a safe update.");
  }
}

async function recordMutationAudit(entry: {
  tool: "create_expense_entry" | "update_expense_entry";
  action: Action;
  confirmation_state: "dry_run" | "confirmed";
  outcome: "attempt" | "success" | "error";
  matter_id: number;
  record_id?: number;
  fields_changed?: string[];
  error_message?: string;
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

const expenseCreateSchema = {
  matter_id: z.number().int().positive().describe("Exact Clio matter ID receiving the expense"),
  allocation_matter_id: z.number().int().positive().describe("Matter to which the underlying cost is attributable; must exactly match matter_id"),
  date: z.string().date().describe("ISO date (YYYY-MM-DD) of the expense"),
  amount: z.number().positive().max(10000000).describe("Expense amount written to Clio as price"),
  expense_category_id: z.number().int().positive().describe("Validated Clio expense category ID"),
  description: z.string().trim().min(5).max(1750).describe("Matter-specific expense description"),
  source_reference: z.string().trim().min(2).max(200).regex(/^[^\r\n]+$/).describe("Single-line supplier invoice or other source reference; appended to the Clio note and never audit-logged"),
  billing_status: z.enum(["billable", "non_billable", "no_charge"]),
  tax_setting: z.enum(["no_tax", "tax_1_only", "tax_2_only", "tax_1_and_tax_2"]),
  cost_type: z.enum([
    "client_recoverable_direct_cost",
    "third_party_fee_recovery",
    "internal_non_billable_cost",
  ]).describe("Business classification reviewed before the Clio ExpenseEntry is created"),
  confirm_write: z.boolean().default(false),
  preview_token: z.string().optional(),
};

export function registerControlledExpenseTools(server: McpServer): void {
  server.registerTool(
    "list_expense_entries",
    {
      title: "List Clio expense entries",
      description: "Lists ExpenseEntry activities with billing, category, tax, ETag, and pagination metadata.",
      inputSchema: {
        matter_id: z.number().int().positive().optional(),
        expense_category_id: z.number().int().positive().optional(),
        start_date: z.string().date().optional(),
        end_date: z.string().date().optional(),
        status: z.enum(["unbilled", "billed", "draft", "non_billable", "billable", "written_off"]).default("unbilled"),
        limit: z.number().int().min(1).max(200).default(25),
        page_token: z.string().optional(),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, expense_category_id, start_date, end_date, status, limit, page_token }) => {
      try {
        const params: Record<string, string> = {
          fields: EXPENSE_FIELDS,
          type: "ExpenseEntry",
          status,
          limit: String(limit),
        };
        if (matter_id) params.matter_id = String(matter_id);
        if (expense_category_id) params.expense_category_id = String(expense_category_id);
        if (start_date) params.start_date = start_date;
        if (end_date) params.end_date = end_date;
        if (page_token) params.page_token = page_token;
        const response = await clioGet("/activities.json", params);
        const entries = Array.isArray(response?.data) ? response.data : [];
        const nextPageToken = entries.length >= limit ? extractNextPageToken(response?.meta) : null;
        await appendAuditLog({
          tool: "list_expense_entries",
          args: { matter_id, expense_category_id, start_date, end_date, status, limit, page_token },
          outcome: "success",
          result_count: entries.length,
          ...(matter_id && { matter_id }),
        });
        return writeJsonResult({
          entries: entries.map(expenseSummary),
          status,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        });
      } catch (error) {
        const message = safeWriteError(error);
        await appendAuditLog({
          tool: "list_expense_entries",
          args: { matter_id, expense_category_id, start_date, end_date, status, limit, page_token },
          outcome: "error",
          error_message: message,
          ...(matter_id && { matter_id }),
        });
        return writeJsonResult({ error: message }, true);
      }
    },
  );

  server.registerTool(
    "get_expense_entry",
    {
      title: "Get one Clio expense entry",
      description: "Retrieves an exact ExpenseEntry, including its ETag for controlled updates.",
      inputSchema: { activity_id: z.number().int().positive() },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ activity_id }) => {
      try {
        const response = await clioGet(`/activities/${activity_id}.json`, { fields: EXPENSE_FIELDS });
        if (response?.data?.type !== "ExpenseEntry") {
          throw new Error("The requested activity is not an ExpenseEntry.");
        }
        await appendAuditLog({ tool: "get_expense_entry", args: { activity_id }, outcome: "success" });
        return writeJsonResult(expenseSummary(response.data));
      } catch (error) {
        const message = safeWriteError(error);
        await appendAuditLog({
          tool: "get_expense_entry",
          args: { activity_id },
          outcome: "error",
          error_message: message,
        });
        return writeJsonResult({ error: message }, true);
      }
    },
  );

  server.registerTool(
    "create_expense_entry",
    {
      title: "Create a controlled Clio expense entry",
      description: "Dry-run by default. Validates the matter and category, checks for duplicates and cross-matter allocation, and requires an unchanged preview token for a production write.",
      inputSchema: expenseCreateSchema,
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, allocation_matter_id, date, amount, expense_category_id, description, source_reference, billing_status, tax_setting, cost_type, confirm_write, preview_token }) => {
      let writeAttempted = false;
      try {
        if (allocation_matter_id !== matter_id) {
          throw new Error("Cross-matter allocation rejected: allocation_matter_id must exactly match matter_id.");
        }
        const candidate: ExpenseCandidate = {
          matter_id, date, amount, expense_category_id, description, source_reference,
          billing_status, tax_setting, cost_type,
        };
        const refs = await validateExpenseReferences(candidate);
        const duplicate = await findDuplicateExpense(candidate);
        if (duplicate) {
          throw new Error(`Duplicate expense rejected; matching ExpenseEntry ${duplicate.id} already exists.`);
        }
        const proposal = {
          matter: { id: refs.matter.id, display_number: refs.matter.display_number },
          allocation_matter_id,
          date,
          amount,
          quantity: 1,
          expense_category: {
            id: refs.category.id,
            name: refs.category.name,
            entry_type: refs.category.entry_type ?? null,
          },
          description,
          source_reference,
          billing_status,
          tax_setting,
          cost_type,
        };

        if (!confirm_write) {
          const auditOk = await recordMutationAudit({
            tool: "create_expense_entry", action: "create", confirmation_state: "dry_run",
            outcome: "success", matter_id,
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_expense_entry",
            proposal,
            await makeWritePreviewToken("create_expense_entry", proposal),
            { duplicate_screening: "no matching matter/date/amount/category/source reference found" },
          ));
        }

        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "create_expense_entry", proposal);
        const duplicateAtWrite = await findDuplicateExpense(candidate);
        if (duplicateAtWrite) {
          throw new Error(`Duplicate expense rejected; matching ExpenseEntry ${duplicateAtWrite.id} appeared after preview.`);
        }
        const preWriteAuditOk = await recordMutationAudit({
          tool: "create_expense_entry", action: "create", confirmation_state: "confirmed",
          outcome: "attempt", matter_id,
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");

        const flags = billingFlags(billing_status);
        writeAttempted = true;
        const response = await clioPost(`/activities.json?fields=${encodeURIComponent(EXPENSE_FIELDS)}`, {
          data: {
            type: "ExpenseEntry",
            date,
            quantity: 1,
            price: amount,
            note: composeExpenseNote(description, source_reference),
            non_billable: flags.non_billable,
            no_charge: flags.no_charge,
            tax_setting,
            matter: { id: matter_id },
            expense_category: { id: expense_category_id },
          },
        });
        const entry = response?.data;
        if (!entry?.id) throw new Error("Clio returned an invalid expense create response.");
        const finalAuditOk = await recordMutationAudit({
          tool: "create_expense_entry", action: "create", confirmation_state: "confirmed",
          outcome: "success", matter_id, record_id: entry.id,
        });
        return writeJsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "create",
          record_id: entry.id,
          etag: entry.etag ?? null,
          audit_recorded: finalAuditOk,
          expense_entry: expenseSummary({ ...entry, type: entry.type ?? "ExpenseEntry" }),
        });
      } catch (error) {
        const message = safeWriteError(error);
        await recordMutationAudit({
          tool: "create_expense_entry", action: "create",
          confirmation_state: confirm_write ? "confirmed" : "dry_run", outcome: "error",
          matter_id, error_message: message,
        });
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && {
            recovery: "Search the target matter for the exact date, amount, category, and source reference before retrying; the API outcome may be ambiguous.",
          }),
        }, true);
      }
    },
  );

  server.registerTool(
    "update_expense_entry",
    {
      title: "Update a controlled unbilled Clio expense entry",
      description: "Dry-run by default. Requires the exact current ETag, preserves matter association, revalidates category and allocation, and requires an unchanged preview token for a production write.",
      inputSchema: {
        activity_id: z.number().int().positive(),
        etag: z.string().min(3),
        allocation_matter_id: z.number().int().positive().describe("Must match the entry's current matter"),
        date: z.string().date().optional(),
        amount: z.number().positive().max(10000000).optional(),
        expense_category_id: z.number().int().positive().optional(),
        description: z.string().trim().min(5).max(1750).optional(),
        source_reference: z.string().trim().min(2).max(200).regex(/^[^\r\n]+$/).optional(),
        billing_status: z.enum(["billable", "non_billable", "no_charge"]).optional(),
        tax_setting: z.enum(["no_tax", "tax_1_only", "tax_2_only", "tax_1_and_tax_2"]).optional(),
        cost_type: z.enum([
          "client_recoverable_direct_cost",
          "third_party_fee_recovery",
          "internal_non_billable_cost",
        ]),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_UPDATE_TOOL_ANNOTATIONS,
    },
    async ({ activity_id, etag, allocation_matter_id, date, amount, expense_category_id, description, source_reference, billing_status, tax_setting, cost_type, confirm_write, preview_token }) => {
      let writeAttempted = false;
      let matterId = 0;
      const fieldsChanged = [
        date !== undefined && "date",
        amount !== undefined && "amount",
        expense_category_id !== undefined && "expense_category",
        description !== undefined && "description",
        source_reference !== undefined && "source_reference",
        billing_status !== undefined && "billing_status",
        tax_setting !== undefined && "tax_setting",
      ].filter(Boolean) as string[];
      try {
        if (fieldsChanged.length === 0) throw new Error("At least one editable field must be supplied.");
        const currentResponse = await clioGet(`/activities/${activity_id}.json`, { fields: EXPENSE_FIELDS });
        const current = currentResponse?.data;
        assertMutableExpense(current, etag);
        matterId = current.matter.id;
        if (allocation_matter_id !== matterId) {
          throw new Error("Cross-matter allocation rejected: allocation_matter_id must match the entry's matter.");
        }

        const currentNote = parseExpenseNote(current.note);
        if (currentNote.source_reference === null && (description === undefined || source_reference === undefined)) {
          throw new Error("The existing entry lacks a controlled source-reference marker; provide both description and source_reference.");
        }
        const candidate: ExpenseCandidate = {
          matter_id: matterId,
          date: date ?? current.date,
          amount: amount ?? Number(current.price),
          expense_category_id: expense_category_id ?? current.expense_category.id,
          description: description ?? currentNote.description,
          source_reference: source_reference ?? currentNote.source_reference ?? "",
          billing_status: billing_status ?? billingStatus(current),
          tax_setting: tax_setting ?? current.tax_setting ?? "no_tax",
          cost_type,
        };
        const refs = await validateExpenseReferences(candidate);
        const duplicate = await findDuplicateExpense(candidate, activity_id);
        if (duplicate) {
          throw new Error(`Duplicate expense rejected; matching ExpenseEntry ${duplicate.id} already exists.`);
        }
        const proposal = {
          record_id: activity_id,
          current_etag: etag,
          matter: { id: refs.matter.id, display_number: refs.matter.display_number },
          allocation_matter_id,
          date: candidate.date,
          amount: candidate.amount,
          quantity: 1,
          expense_category: {
            id: refs.category.id,
            name: refs.category.name,
            entry_type: refs.category.entry_type ?? null,
          },
          description: candidate.description,
          source_reference: candidate.source_reference,
          billing_status: candidate.billing_status,
          tax_setting: candidate.tax_setting,
          cost_type,
          fields_changed: fieldsChanged,
        };

        if (!confirm_write) {
          const auditOk = await recordMutationAudit({
            tool: "update_expense_entry", action: "update", confirmation_state: "dry_run",
            outcome: "success", matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "update_expense_entry",
            proposal,
            await makeWritePreviewToken("update_expense_entry", proposal),
            { duplicate_screening: "no conflicting expense found" },
          ));
        }

        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "update_expense_entry", proposal);
        const duplicateAtWrite = await findDuplicateExpense(candidate, activity_id);
        if (duplicateAtWrite) {
          throw new Error(`Duplicate expense rejected; matching ExpenseEntry ${duplicateAtWrite.id} appeared after preview.`);
        }
        const preWriteAuditOk = await recordMutationAudit({
          tool: "update_expense_entry", action: "update", confirmation_state: "confirmed",
          outcome: "attempt", matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");

        const data: Record<string, unknown> = {};
        if (date !== undefined) data.date = date;
        if (amount !== undefined) data.price = amount;
        if (expense_category_id !== undefined) data.expense_category = { id: expense_category_id };
        if (description !== undefined || source_reference !== undefined) {
          data.note = composeExpenseNote(candidate.description, candidate.source_reference);
        }
        if (billing_status !== undefined) Object.assign(data, billingFlags(billing_status));
        if (tax_setting !== undefined) data.tax_setting = tax_setting;
        writeAttempted = true;
        const response = await clioPatch(
          `/activities/${activity_id}.json?fields=${encodeURIComponent(EXPENSE_FIELDS)}`,
          { data },
          { "If-Match": etag },
        );
        const entry = response?.data;
        if (!entry?.id) throw new Error("Clio returned an invalid expense update response.");
        const finalAuditOk = await recordMutationAudit({
          tool: "update_expense_entry", action: "update", confirmation_state: "confirmed",
          outcome: "success", matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
        });
        return writeJsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "update",
          record_id: activity_id,
          previous_etag: etag,
          etag: entry.etag ?? null,
          audit_recorded: finalAuditOk,
          expense_entry: expenseSummary({ ...entry, type: entry.type ?? "ExpenseEntry" }),
        });
      } catch (error) {
        const message = safeWriteError(error);
        await recordMutationAudit({
          tool: "update_expense_entry", action: "update",
          confirmation_state: confirm_write ? "confirmed" : "dry_run", outcome: "error",
          matter_id: matterId, record_id: activity_id, fields_changed: fieldsChanged,
          error_message: message,
        });
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && {
            recovery: "Retrieve the current Clio expense before retrying; the API outcome may be ambiguous.",
          }),
        }, true);
      }
    },
  );
}
