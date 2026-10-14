import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPatch, clioPost, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import {
  consumeWritePreviewToken,
  makeWritePreviewToken,
  writeJsonResult,
  writePreviewEnvelope,
} from "../esq/writePreview.js";
import {
  CLIO_CREATE_TOOL_ANNOTATIONS,
  CLIO_READ_ONLY_TOOL_ANNOTATIONS,
  CLIO_UPDATE_TOOL_ANNOTATIONS,
} from "./annotations.js";

const CONTACT_LIST_FIELDS =
  "id,name,email_addresses{address,name},phone_numbers{number,name},company{id,name},type";

const CONTACT_DETAIL_FIELDS =
  "id,name,first_name,last_name,title,email_addresses{address,name},phone_numbers{number,name},company{id,name},type,created_at,updated_at,addresses{name,street,city,province,postal_code,country},custom_field_values{id,field_name,field_type,value,custom_field}";

type ContactCustomField = {
  definition_id: number;
  name: string;
  value_type: string;
  value: unknown;
};

const emailSchema = z.string().email().max(254).optional();
const contactTypeSchema = z.enum(["Person", "Company"]);
const contactFieldsSchema = {
  type: contactTypeSchema.optional(),
  name: z.string().trim().min(1).max(255).optional(),
  first_name: z.string().trim().min(1).max(255).optional(),
  last_name: z.string().trim().min(1).max(255).optional(),
  title: z.string().trim().max(255).optional(),
  email: emailSchema,
  phone: z.string().trim().min(3).max(50).optional(),
  company_id: z.number().int().positive().optional(),
  street: z.string().trim().max(500).optional(),
  city: z.string().trim().max(255).optional(),
  province: z.string().trim().max(255).optional(),
  postal_code: z.string().trim().max(50).optional(),
  country: z.string().trim().max(255).optional(),
};

function buildContactData(input: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of ["type", "name", "first_name", "last_name", "title"] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  if (input.email !== undefined) {
    data.email_addresses = [{ name: "Work", address: input.email, default_email: true }];
  }
  if (input.phone !== undefined) data.phone_numbers = [{ name: "Work", number: input.phone }];
  if (input.company_id !== undefined) data.company = { id: input.company_id };
  if (["street", "city", "province", "postal_code", "country"].some((key) => input[key] !== undefined)) {
    data.addresses = [{
      name: "Work",
      ...Object.fromEntries(
        ["street", "city", "province", "postal_code", "country"]
          .filter((key) => input[key] !== undefined)
          .map((key) => [key, input[key]]),
      ),
    }];
  }
  return data;
}

async function validateContactCompany(companyId: unknown): Promise<{ id: number; name: string } | null> {
  if (companyId === undefined) return null;
  const response = await clioGet(`/contacts/${companyId}.json`, { fields: "id,name,type" });
  if (response?.data?.type !== "Company") throw new Error("company_id must identify a Company contact.");
  return { id: response.data.id, name: response.data.name };
}

async function recordContactMutation(
  tool: "create_contact" | "update_contact",
  confirmationState: "dry_run" | "confirmed",
  outcome: "success" | "error",
  fieldsChanged: string[],
  recordId?: number,
  errorMessage?: string,
): Promise<boolean> {
  return appendAuditLog({
    tool,
    action: tool === "create_contact" ? "create" : "update",
    confirmation_state: confirmationState,
    outcome,
    ...(recordId !== undefined && { record_id: recordId }),
    ...(errorMessage !== undefined && { error_message: errorMessage }),
    args: { confirm_write: confirmationState === "confirmed", fields_changed: fieldsChanged },
  });
}

export function parseContactCustomFields(value: unknown): ContactCustomField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Malformed Clio contact custom_field_values response");

  const seen = new Set<number>();
  return value.map((entry: any) => {
    const definitionId = entry?.custom_field?.id;
    if (!Number.isInteger(definitionId) || typeof entry?.field_name !== "string" ||
        typeof entry?.field_type !== "string" || !("value" in entry)) {
      throw new Error("Malformed Clio contact custom field value");
    }
    if (seen.has(definitionId)) {
      throw new Error("Duplicate Clio contact custom field definition");
    }
    seen.add(definitionId);
    return {
      definition_id: definitionId,
      name: entry.field_name,
      value_type: entry.field_type,
      value: entry.value,
    };
  });
}

export function registerContactTools(server: McpServer): void {
  server.registerTool(
    "search_contacts",
    {
      description: "Search Clio contacts by name, email, or company",
      inputSchema: {
        query: z.string().min(1).describe("Search string (name, email, or company)"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1–200)"),
        page_token: z.string().optional().describe("Cursor from a previous search_contacts response to fetch the next page"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ query, limit, page_token }) => {
      try {
        const params: Record<string, string> = { query, fields: CONTACT_LIST_FIELDS, limit: String(limit) };
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/contacts.json", params);
        const contacts = data.data as any[];
        const nextPageToken = contacts.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({ tool: "search_contacts", args: { query, limit, page_token }, outcome: "success", result_count: contacts?.length ?? 0 });

        if (!contacts || contacts.length === 0) {
          return { content: [{ type: "text", text: "No contacts found." }] };
        }

        const result = {
          contacts: contacts.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.email_addresses?.[0]?.address ?? null,
            phone: c.phone_numbers?.[0]?.number ?? null,
            company: c.company?.name ?? null,
            type: c.type,
          })),
          total_count: data.meta?.records ?? contacts.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "search_contacts", args: { query, limit, page_token }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_contact",
    {
      description: "Get full detail for a single contact by ID",
      inputSchema: {
        contact_id: z.number().int().positive().describe("The Clio contact ID"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ contact_id }) => {
      try {
        const data = await clioGet(`/contacts/${contact_id}.json`, { fields: CONTACT_DETAIL_FIELDS });
        const c = data.data;

        const result = {
          id: c.id,
          name: c.name,
          first_name: c.first_name ?? null,
          last_name: c.last_name ?? null,
          title: c.title ?? null,
          type: c.type,
          company: c.company ? { id: c.company.id, name: c.company.name } : null,
          emails: (c.email_addresses ?? []).map((e: any) => ({ label: e.name, address: e.address })),
          phone_numbers: (c.phone_numbers ?? []).map((p: any) => ({ label: p.name, number: p.number })),
          addresses: (c.addresses ?? []).map((a: any) => ({
            label: a.name,
            street: a.street ?? null,
            city: a.city ?? null,
            province: a.province ?? null,
            postal_code: a.postal_code ?? null,
            country: a.country ?? null,
          })),
          created_at: c.created_at,
          updated_at: c.updated_at,
          custom_field_values: parseContactCustomFields(c.custom_field_values),
        };

        await appendAuditLog({ tool: "get_contact", args: { contact_id }, outcome: "success" });

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_contact", args: { contact_id }, outcome: "success" });
          return { content: [{ type: "text", text: `Contact ${contact_id} not found.` }] };
        }
        await appendAuditLog({ tool: "get_contact", args: { contact_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_contact",
    {
      title: "Create a controlled Clio contact",
      description:
        "Dry-run by default. Displays the exact proposed person or company contact and possible duplicate matches. A production write requires confirm_write: true plus the unexpired preview_token from an unchanged dry-run proposal.",
      inputSchema: {
        type: contactTypeSchema.describe("Person or Company"),
        name: z.string().trim().min(1).max(255).describe("Full person name or legal company name"),
        first_name: contactFieldsSchema.first_name,
        last_name: contactFieldsSchema.last_name,
        title: contactFieldsSchema.title,
        email: contactFieldsSchema.email,
        phone: contactFieldsSchema.phone,
        company_id: contactFieldsSchema.company_id,
        street: contactFieldsSchema.street,
        city: contactFieldsSchema.city,
        province: contactFieldsSchema.province,
        postal_code: contactFieldsSchema.postal_code,
        country: contactFieldsSchema.country,
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async (input) => {
      const confirmationState = input.confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      const fieldsChanged = Object.keys(buildContactData(input));
      try {
        const company = await validateContactCompany(input.company_id);
        const data = buildContactData(input);
        const proposal = { ...data, ...(company && { company }) };

        if (!input.confirm_write) {
          const duplicateResponse = await clioGet("/contacts.json", {
            query: input.email ?? input.name,
            fields: CONTACT_LIST_FIELDS,
            limit: "5",
          });
          const possibleDuplicates = (duplicateResponse?.data ?? []).map((c: any) => ({
            id: c.id, name: c.name, type: c.type, email: c.email_addresses?.[0]?.address ?? null,
          }));
          const auditOk = await recordContactMutation("create_contact", "dry_run", "success", fieldsChanged);
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_contact",
            proposal,
            makeWritePreviewToken("create_contact", proposal),
            { possible_duplicates: possibleDuplicates },
          ));
        }

        if (!input.preview_token) throw new Error("preview_token is required when confirm_write is true.");
        consumeWritePreviewToken(input.preview_token, "create_contact", proposal);
        const preWriteAuditOk = await recordContactMutation("create_contact", "confirmed", "success", fieldsChanged);
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const response = await clioPost("/contacts.json", { data });
        if (!response?.data?.id) throw new Error("Clio returned an invalid create response.");
        const auditOk = await recordContactMutation(
          "create_contact", "confirmed", "success", fieldsChanged, response.data.id,
        );
        return writeJsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "create_contact",
          record_id: response.data.id,
          audit_recorded: auditOk,
          contact: response.data,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await recordContactMutation("create_contact", confirmationState, "error", fieldsChanged, undefined, message);
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Search Clio for the proposed contact before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    },
  );

  server.registerTool(
    "update_contact",
    {
      title: "Update a controlled Clio contact",
      description:
        "Dry-run by default. Reads the current contact and displays the exact proposed changes. A production write requires confirm_write: true plus the unexpired preview_token; the token is invalidated if the contact changes before confirmation.",
      inputSchema: {
        contact_id: z.number().int().positive().describe("Exact Clio contact ID"),
        ...contactFieldsSchema,
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_UPDATE_TOOL_ANNOTATIONS,
    },
    async (input) => {
      const confirmationState = input.confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      const data = buildContactData(input);
      const fieldsChanged = Object.keys(data);
      try {
        if (fieldsChanged.length === 0) throw new Error("At least one contact field must be supplied.");
        const company = await validateContactCompany(input.company_id);
        const currentResponse = await clioGet(`/contacts/${input.contact_id}.json`, {
          fields: CONTACT_DETAIL_FIELDS,
        });
        const current = currentResponse?.data;
        if (!current?.id) throw new Error("Contact validation failed.");
        const proposal = {
          record_id: input.contact_id,
          current_updated_at: current.updated_at,
          current: {
            name: current.name, type: current.type,
            email: current.email_addresses?.[0]?.address ?? null,
            phone: current.phone_numbers?.[0]?.number ?? null,
          },
          changes: { ...data, ...(company && { company }) },
          fields_changed: fieldsChanged,
        };

        if (!input.confirm_write) {
          const auditOk = await recordContactMutation(
            "update_contact", "dry_run", "success", fieldsChanged, input.contact_id,
          );
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "update_contact", proposal, makeWritePreviewToken("update_contact", proposal),
          ));
        }

        if (!input.preview_token) throw new Error("preview_token is required when confirm_write is true.");
        consumeWritePreviewToken(input.preview_token, "update_contact", proposal);
        const preWriteAuditOk = await recordContactMutation(
          "update_contact", "confirmed", "success", fieldsChanged, input.contact_id,
        );
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const response = await clioPatch(`/contacts/${input.contact_id}.json`, { data });
        if (!response?.data?.id) throw new Error("Clio returned an invalid update response.");
        const auditOk = await recordContactMutation(
          "update_contact", "confirmed", "success", fieldsChanged, input.contact_id,
        );
        return writeJsonResult({
          mode: "confirmed_write",
          write_performed: true,
          action: "update_contact",
          record_id: input.contact_id,
          audit_recorded: auditOk,
          contact: response.data,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await recordContactMutation(
          "update_contact", confirmationState, "error", fieldsChanged, input.contact_id, message,
        );
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Retrieve the current Clio contact before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    },
  );
}
