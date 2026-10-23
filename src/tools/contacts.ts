import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPatch, clioPost, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
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

const CONTACT_LIST_FIELDS =
  "id,name,email_addresses{address,name},phone_numbers{number,name},company{id,name},type";

const CONTACT_DETAIL_FIELDS =
  "id,etag,name,prefix,first_name,middle_name,last_name,title,date_of_birth,clio_connect_email,ledes_client_id,sales_tax_number,require_utbms_codes," +
  "email_addresses{id,address,name,default_email},phone_numbers{id,number,name,default_number},web_sites{id,address,name,default_web_site}," +
  "company{id,name},type,created_at,updated_at,addresses{id,name,street,city,province,postal_code,country}," +
  "custom_field_values{id,field_name,field_type,value,custom_field}";

type ContactCustomField = {
  definition_id: number;
  name: string;
  value_type: string;
  value: unknown;
};

const emailSchema = z.string().email().max(254).optional();
const contactTypeSchema = z.enum(["Person", "Company"]);
const customFieldValueSchema = z.object({
  custom_field_id: z.number().int().positive(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
const emailAddressSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.enum(["Work", "Home", "Other"]).default("Work"),
  address: z.string().email().max(254),
  default_email: z.boolean().optional(),
});
const phoneNumberSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.enum(["Work", "Home", "Mobile", "Fax", "Pager", "Skype", "Other"]).default("Work"),
  number: z.string().trim().min(3).max(50),
  default_number: z.boolean().optional(),
});
const addressSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.enum(["Work", "Home", "Billing", "Other"]).default("Work"),
  street: z.string().trim().max(500).optional(), city: z.string().trim().max(255).optional(),
  province: z.string().trim().max(255).optional(), postal_code: z.string().trim().max(50).optional(),
  country: z.string().trim().max(255).optional(),
});
const webSiteSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.enum(["Work", "Personal", "Twitter", "Facebook", "LinkedIn", "Instant Messenger", "Other"]).default("Work"),
  address: z.string().url().max(2048), default_web_site: z.boolean().optional(),
});
const contactFieldsSchema = {
  type: contactTypeSchema.optional(),
  name: z.string().trim().min(1).max(255).optional(),
  prefix: z.string().trim().max(50).optional(),
  first_name: z.string().trim().min(1).max(255).optional(),
  middle_name: z.string().trim().max(255).optional(),
  last_name: z.string().trim().min(1).max(255).optional(),
  title: z.string().trim().max(255).optional(),
  date_of_birth: z.string().date().optional(),
  email: emailSchema,
  phone: z.string().trim().min(3).max(50).optional(),
  company_id: z.number().int().positive().optional(),
  street: z.string().trim().max(500).optional(),
  city: z.string().trim().max(255).optional(),
  province: z.string().trim().max(255).optional(),
  postal_code: z.string().trim().max(50).optional(),
  country: z.string().trim().max(255).optional(),
  web_site: z.string().url().max(2048).optional(),
  clio_connect_email: z.string().email().max(254).optional(),
  ledes_client_id: z.string().trim().max(255).optional(),
  sales_tax_number: z.string().trim().max(255).optional(),
  require_utbms_codes: z.boolean().optional(),
  custom_field_values: z.array(customFieldValueSchema).max(100).optional(),
  email_addresses: z.array(emailAddressSchema).max(20).optional(),
  phone_numbers: z.array(phoneNumberSchema).max(20).optional(),
  addresses: z.array(addressSchema).max(20).optional(),
  web_sites: z.array(webSiteSchema).max(20).optional(),
};

function buildContactData(input: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of [
    "type", "name", "prefix", "first_name", "middle_name", "last_name", "title",
    "date_of_birth", "clio_connect_email", "ledes_client_id", "sales_tax_number",
    "require_utbms_codes",
  ] as const) {
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
  if (input.web_site !== undefined) {
    data.web_sites = [{ name: "Work", address: input.web_site, default_web_site: true }];
  }
  if (input.custom_field_values !== undefined) {
    data.custom_field_values = buildNewCustomFieldValues(input.custom_field_values);
  }
  for (const key of ["email_addresses", "phone_numbers", "addresses", "web_sites"] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  return data;
}

function assertNoConflictingContactAliases(input: Record<string, unknown>): void {
  const conflicts = [
    [input.email, input.email_addresses, "email and email_addresses"],
    [input.phone, input.phone_numbers, "phone and phone_numbers"],
    [input.web_site, input.web_sites, "web_site and web_sites"],
    [
      [input.street, input.city, input.province, input.postal_code, input.country].some((value) => value !== undefined),
      input.addresses,
      "singular address fields and addresses",
    ],
  ] as const;
  for (const [singular, plural, label] of conflicts) {
    if (singular !== undefined && singular !== false && plural !== undefined) {
      throw new Error(`Supply either ${label}, not both.`);
    }
  }
}

function existingEntry(entries: any[], kind: string, preferDefault = false, entryId?: number): any | undefined {
  if (!Array.isArray(entries)) throw new Error(`Malformed contact ${kind} response.`);
  if (entryId !== undefined) {
    const match = entries.find((entry) => entry.id === entryId);
    if (!match) throw new Error(`The selected ${kind} entry does not belong to this contact.`);
    return match;
  }
  const defaults = preferDefault ? entries.filter((entry) => entry.default_email === true) : [];
  const workEntries = entries.filter((entry) => entry.name === "Work");
  const candidates = defaults.length ? defaults : workEntries.length ? workEntries : entries;
  if (candidates.length > 1) {
    throw new Error(`Multiple ${kind} entries match; resolve the ambiguous contact entries in Clio before updating.`);
  }
  const entry = candidates[0];
  if (entry && (!Number.isInteger(entry.id) || entry.id <= 0)) {
    throw new Error(`The existing ${kind} entry has no valid ID; no update can be performed safely.`);
  }
  return entry;
}

function buildContactUpdateData(input: Record<string, unknown>, current: any): Record<string, unknown> {
  const data = buildContactData(input);
  if (input.custom_field_values !== undefined) {
    data.custom_field_values = buildUpdatedCustomFieldValues(
      input.custom_field_values,
      current.custom_field_values,
    );
  }
  if (input.email !== undefined) {
    const entry = existingEntry(current.email_addresses ?? [], "email", true, input.email_id as number | undefined);
    data.email_addresses = [{
      ...(entry && { id: entry.id }),
      name: entry?.name ?? "Work",
      address: input.email,
      default_email: entry?.default_email ?? true,
    }];
  }
  if (input.phone !== undefined) {
    const entry = existingEntry(current.phone_numbers ?? [], "phone", false, input.phone_id as number | undefined);
    data.phone_numbers = [{ ...(entry && { id: entry.id }), name: entry?.name ?? "Work", number: input.phone }];
  }
  if (input.addresses !== undefined) {
    data.addresses = (input.addresses as Array<Record<string, unknown>>).map((changes) => {
      const id = changes.id as number | undefined;
      if (id === undefined) return changes;
      const entry = existingEntry(current.addresses ?? [], "address", false, id);
      return { ...entry, ...changes, id: entry.id };
    });
  } else if (data.addresses) {
    const entry = existingEntry(current.addresses ?? [], "address", false, input.address_id as number | undefined);
    const changes = (data.addresses as Record<string, unknown>[])[0];
    data.addresses = [{
      ...(entry && { id: entry.id }),
      ...Object.fromEntries(
        ["street", "city", "province", "postal_code", "country"]
          .filter((key) => entry?.[key] !== undefined && entry[key] !== null)
          .map((key) => [key, entry[key]]),
      ),
      ...changes,
      name: entry?.name ?? "Work",
    }];
  }
  if (input.web_site !== undefined) {
    const entry = existingEntry(current.web_sites ?? [], "website", false, input.web_site_id as number | undefined);
    data.web_sites = [{
      ...(entry && { id: entry.id }),
      name: entry?.name ?? "Work",
      address: input.web_site,
      default_web_site: entry?.default_web_site ?? true,
    }];
  }
  return data;
}

async function validateContactCompany(companyId: unknown): Promise<{ id: number; name: string } | null> {
  if (companyId === undefined) return null;
  const response = await clioGet(`/contacts/${companyId}.json`, { fields: "id,name,type" });
  if (response?.data?.id !== companyId || response.data.type !== "Company") {
    throw new Error("company_id must identify the exact Company contact.");
  }
  return { id: response.data.id, name: response.data.name };
}

async function recordContactMutation(
  tool: "create_contact" | "update_contact",
  confirmationState: "dry_run" | "confirmed",
  outcome: "attempt" | "success" | "error",
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
          etag: c.etag ?? null,
          name: c.name,
          prefix: c.prefix ?? null,
          first_name: c.first_name ?? null,
          middle_name: c.middle_name ?? null,
          last_name: c.last_name ?? null,
          title: c.title ?? null,
          date_of_birth: c.date_of_birth ?? null,
          type: c.type,
          company: c.company ? { id: c.company.id, name: c.company.name } : null,
          emails: (c.email_addresses ?? []).map((e: any) => ({ id: e.id, label: e.name, address: e.address, default_email: e.default_email })),
          phone_numbers: (c.phone_numbers ?? []).map((p: any) => ({ id: p.id, label: p.name, number: p.number })),
          web_sites: (c.web_sites ?? []).map((w: any) => ({ id: w.id, label: w.name, address: w.address, default_web_site: w.default_web_site })),
          addresses: (c.addresses ?? []).map((a: any) => ({
            id: a.id,
            label: a.name,
            street: a.street ?? null,
            city: a.city ?? null,
            province: a.province ?? null,
            postal_code: a.postal_code ?? null,
            country: a.country ?? null,
          })),
          created_at: c.created_at,
          updated_at: c.updated_at,
          clio_connect_email: c.clio_connect_email ?? null,
          ledes_client_id: c.ledes_client_id ?? null,
          sales_tax_number: c.sales_tax_number ?? null,
          require_utbms_codes: c.require_utbms_codes ?? null,
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
        prefix: contactFieldsSchema.prefix,
        middle_name: contactFieldsSchema.middle_name,
        last_name: contactFieldsSchema.last_name,
        title: contactFieldsSchema.title,
        date_of_birth: contactFieldsSchema.date_of_birth,
        email: contactFieldsSchema.email,
        phone: contactFieldsSchema.phone,
        company_id: contactFieldsSchema.company_id,
        street: contactFieldsSchema.street,
        city: contactFieldsSchema.city,
        province: contactFieldsSchema.province,
        postal_code: contactFieldsSchema.postal_code,
        country: contactFieldsSchema.country,
        web_site: contactFieldsSchema.web_site,
        clio_connect_email: contactFieldsSchema.clio_connect_email,
        ledes_client_id: contactFieldsSchema.ledes_client_id,
        sales_tax_number: contactFieldsSchema.sales_tax_number,
        require_utbms_codes: contactFieldsSchema.require_utbms_codes,
        custom_field_values: contactFieldsSchema.custom_field_values,
        email_addresses: contactFieldsSchema.email_addresses,
        phone_numbers: contactFieldsSchema.phone_numbers,
        addresses: contactFieldsSchema.addresses,
        web_sites: contactFieldsSchema.web_sites,
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async (input) => {
      const confirmationState = input.confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      let fieldsChanged: string[] = [];
      try {
        assertNoConflictingContactAliases(input);
        const company = await validateContactCompany(input.company_id);
        const data = buildContactData(input);
        fieldsChanged = Object.keys(data);
        const proposal = { ...data, ...(company && { company }) };

        if (!input.confirm_write) {
          const duplicateQueries = [...new Set([input.name, input.email].filter((value): value is string => Boolean(value)))];
          const duplicateResponses = await Promise.all(duplicateQueries.map((query) => clioGet("/contacts.json", {
            query, fields: CONTACT_LIST_FIELDS, limit: "5",
          })));
          const duplicateById = new Map<number, any>();
          for (const response of duplicateResponses) {
            for (const contact of response?.data ?? []) duplicateById.set(contact.id, contact);
          }
          const possibleDuplicates = [...duplicateById.values()].map((c: any) => ({
            id: c.id, name: c.name, type: c.type, email: c.email_addresses?.[0]?.address ?? null,
          }));
          const auditOk = await recordContactMutation("create_contact", "dry_run", "success", fieldsChanged);
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_contact",
            proposal,
            await makeWritePreviewToken("create_contact", proposal),
            { possible_duplicates: possibleDuplicates },
          ));
        }

        if (!input.preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(input.preview_token, "create_contact", proposal);
        const preWriteAuditOk = await recordContactMutation("create_contact", "confirmed", "attempt", fieldsChanged);
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
        const message = safeWriteError(error);
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
        email_id: z.number().int().positive().optional().describe("Existing email entry ID; use to select among multiple entries"),
        phone_id: z.number().int().positive().optional().describe("Existing phone entry ID; use to select among multiple entries"),
        address_id: z.number().int().positive().optional().describe("Existing address entry ID; use to select among multiple entries"),
        web_site_id: z.number().int().positive().optional().describe("Existing website entry ID; use to select among multiple entries"),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_UPDATE_TOOL_ANNOTATIONS,
    },
    async (input) => {
      const confirmationState = input.confirm_write ? "confirmed" : "dry_run";
      let writeAttempted = false;
      let fieldsChanged: string[] = [];
      try {
        assertNoConflictingContactAliases(input);
        const preliminaryData = buildContactData(input);
        fieldsChanged = Object.keys(preliminaryData);
        if (fieldsChanged.length === 0) throw new Error("At least one contact field must be supplied.");
        if ((input.email_id !== undefined && input.email === undefined) ||
            (input.phone_id !== undefined && input.phone === undefined) ||
            (input.address_id !== undefined && !fieldsChanged.includes("addresses")) ||
            (input.web_site_id !== undefined && input.web_site === undefined)) {
          throw new Error("An entry selector requires changes to that entry.");
        }
        const company = await validateContactCompany(input.company_id);
        const currentResponse = await clioGet(`/contacts/${input.contact_id}.json`, {
          fields: CONTACT_DETAIL_FIELDS,
        });
        const current = currentResponse?.data;
        if (current?.id !== input.contact_id) throw new Error("Contact validation failed.");
        if (typeof current.etag !== "string" || !current.etag.trim()) {
          throw new Error("Clio did not return a contact ETag; no update can be performed safely.");
        }
        const data = buildContactUpdateData(input, current);
        const proposal = {
          record_id: input.contact_id,
          current_etag: current.etag,
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
            "update_contact", proposal, await makeWritePreviewToken("update_contact", proposal),
          ));
        }

        if (!input.preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(input.preview_token, "update_contact", proposal);
        const preWriteAuditOk = await recordContactMutation(
          "update_contact", "confirmed", "attempt", fieldsChanged, input.contact_id,
        );
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const response = await clioPatch(`/contacts/${input.contact_id}.json`, { data }, { "If-Match": current.etag });
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
        const message = safeWriteError(error);
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
