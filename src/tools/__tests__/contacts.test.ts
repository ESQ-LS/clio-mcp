import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const { mockClioGet, mockClioPost, mockClioPatch, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockClioPatch: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet, clioPost: mockClioPost, clioPatch: mockClioPatch };
});
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: vi.fn(async () => ({ clio_user_id: "100", expires_at: Date.now() + 60000 })),
}));

import { ClioApiError } from "../../utils/clioClient.js";
import { registerContactTools } from "../contacts.js";

function getHandlers(): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  const server = {
    registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; },
  } as unknown as McpServer;
  registerContactTools(server);
  return handlers;
}

function contact(custom_field_values?: unknown) {
  return { data: { id: 42, name: "Synthetic Company", type: "Company", custom_field_values } };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
});

describe("get_contact custom fields", () => {
  it("returns an empty array when custom fields are absent", async () => {
    mockClioGet.mockResolvedValue(contact());
    const result = await getHandlers().get_contact({ contact_id: 42 });
    expect(JSON.parse(result.content[0].text).custom_field_values).toEqual([]);
  });

  it("returns definition ID, name, type, and value", async () => {
    mockClioGet.mockResolvedValue(contact([{
      id: "text_line-7001", field_name: "Synthetic Registry Number",
      field_type: "text_line", value: "SYN-123", custom_field: { id: 7001 },
    }]));
    const result = await getHandlers().get_contact({ contact_id: 42 });
    expect(JSON.parse(result.content[0].text).custom_field_values).toEqual([{
      definition_id: 7001, name: "Synthetic Registry Number",
      value_type: "text_line", value: "SYN-123",
    }]);
    expect(mockClioGet.mock.calls[0][1].fields).toContain(
      "custom_field_values{id,field_name,field_type,value,custom_field}"
    );
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      tool: "get_contact", args: { contact_id: 42 }, outcome: "success",
    });
  });

  it("fails closed on duplicate definitions", async () => {
    const field = { field_name: "Synthetic", field_type: "text_line", value: "A", custom_field: { id: 7001 } };
    mockClioGet.mockResolvedValue(contact([field, { ...field, value: "B" }]));
    const result = await getHandlers().get_contact({ contact_id: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Duplicate");
  });

  it("fails closed on malformed custom fields", async () => {
    mockClioGet.mockResolvedValue(contact([{ field_name: "Synthetic", value: "A" }]));
    const result = await getHandlers().get_contact({ contact_id: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Malformed");
  });

  it("returns an error on unauthorized access without logging field values", async () => {
    mockClioGet.mockRejectedValue(new ClioApiError(403, "Forbidden"));
    const result = await getHandlers().get_contact({ contact_id: 42 });
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      tool: "get_contact", args: { contact_id: 42 }, outcome: "error", error_message: "Forbidden",
    });
    expect(JSON.stringify(mockAppendAuditLog.mock.calls)).not.toContain("custom_field_values");
  });
});

describe("controlled contact writes", () => {
  it("previews duplicates and confirms an unchanged create", async () => {
    mockClioGet.mockResolvedValue({ data: [{ id: 9, name: "Existing", type: "Company", email_addresses: [] }] });
    mockClioPost.mockResolvedValue({ data: { id: 43, name: "Synthetic Co", type: "Company" } });
    const handlers = getHandlers();
    const args = { type: "Company", name: "Synthetic Co", email: "intake@example.com", confirm_write: false };
    const preview = JSON.parse((await handlers.create_contact(args)).content[0].text);
    expect(preview.possible_duplicates).toHaveLength(1);
    expect(mockClioPost).not.toHaveBeenCalled();

    const confirmed = await handlers.create_contact({
      ...args,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(JSON.parse(confirmed.content[0].text).write_performed).toBe(true);
    expect(mockClioPost).toHaveBeenCalledWith("/contacts.json", {
      data: expect.objectContaining({ name: "Synthetic Co", type: "Company" }),
    });
  });

  it("invalidates confirmation when duplicate results change after preview", async () => {
    let duplicateExists = false;
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/contacts.json") return { data: duplicateExists ? [{
        id: 88, name: "Synthetic Co", type: "Company",
        email_addresses: [{ address: "intake@example.test" }],
      }] : [] };
      throw new Error(`unexpected path ${requestPath}`);
    });
    const handlers = getHandlers();
    const args = { type: "Company", name: "Synthetic Co", email: "intake@example.test" };
    const preview = JSON.parse((await handlers.create_contact(args)).content[0].text);
    expect(preview.proposal.possible_duplicates).toEqual([]);

    duplicateExists = true;
    const result = await handlers.create_contact({
      ...args,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("proposal changed");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("searches both name and email for duplicates and deduplicates by ID", async () => {
    mockClioGet
      .mockResolvedValueOnce({ data: [{ id: 9, name: "Synthetic Co", type: "Company", email_addresses: [] }] })
      .mockResolvedValueOnce({ data: [
        { id: 9, name: "Synthetic Co", type: "Company", email_addresses: [] },
        { id: 10, name: "Other", type: "Company", email_addresses: [{ address: "intake@example.com" }] },
      ] });
    const preview = JSON.parse((await getHandlers().create_contact({
      type: "Company", name: "Synthetic Co", email: "intake@example.com",
    })).content[0].text);
    expect(mockClioGet.mock.calls.map((call) => call[1].query)).toEqual(["Synthetic Co", "intake@example.com"]);
    expect(preview.possible_duplicates.map((contact: any) => contact.id)).toEqual([9, 10]);
  });

  it("includes ordinary profile and custom fields in an unchanged create", async () => {
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/custom_fields/7001.json") return { data: {
        id: 7001, name: "Registry number", field_type: "text_line", parent_type: "Contact",
      } };
      if (requestPath === "/contacts.json") return { data: [] };
      throw new Error(`unexpected path ${requestPath}`);
    });
    mockClioPost.mockResolvedValue({ data: { id: 44, name: "Synthetic Person", type: "Person" } });
    const handlers = getHandlers();
    const args = {
      type: "Person", name: "Synthetic Person", prefix: "Ms.", middle_name: "Example",
      date_of_birth: "1980-01-02", web_site: "https://example.test",
      custom_field_values: [{ custom_field_id: 7001, value: "SYN-123" }],
      confirm_write: false,
    };
    const preview = JSON.parse((await handlers.create_contact(args)).content[0].text);
    expect(preview.proposal.custom_field_value_details).toEqual([{
      custom_field: {
        id: 7001, name: "Registry number", field_type: "text_line", parent_type: "Contact",
      },
      value: "SYN-123",
    }]);
    await handlers.create_contact({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/contacts.json", { data: expect.objectContaining({
      prefix: "Ms.", middle_name: "Example", date_of_birth: "1980-01-02",
      web_sites: [{ name: "Work", address: "https://example.test", default_web_site: true }],
      custom_field_values: [{ custom_field: { id: 7001 }, value: "SYN-123" }],
    }) });
  });

  it("supports multiple non-destructive contact methods and addresses", async () => {
    mockClioGet.mockResolvedValue({ data: [] });
    mockClioPost.mockResolvedValue({ data: { id: 45, name: "Synthetic Person", type: "Person" } });
    const handlers = getHandlers();
    const args = {
      type: "Person", name: "Synthetic Person",
      email_addresses: [
        { name: "Work", address: "work@example.test", default_email: true },
        { name: "Home", address: "home@example.test" },
      ],
      phone_numbers: [{ name: "Mobile", number: "4165550100", default_number: true }],
      addresses: [{ name: "Work", street: "1 Synthetic Street", city: "Toronto", country: "Canada" }],
      web_sites: [{ name: "LinkedIn", address: "https://example.test/profile" }],
    };
    const preview = JSON.parse((await handlers.create_contact(args)).content[0].text);
    await handlers.create_contact({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/contacts.json", { data: expect.objectContaining({
      email_addresses: args.email_addresses,
      phone_numbers: args.phone_numbers,
      addresses: args.addresses,
      web_sites: args.web_sites,
    }) });
  });

  it("rejects conflicting singular and plural contact aliases", async () => {
    const handlers = getHandlers();
    const result = await handlers.create_contact({
      type: "Person", name: "Synthetic Person", email: "one@example.test",
      email_addresses: [{ name: "Work", address: "two@example.test" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not both");
    expect(mockClioPost).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
  });

  it("rejects nested association IDs when creating contacts", async () => {
    const handlers = getHandlers();
    for (const nested of [
      { email_addresses: [{ id: 11, name: "Work", address: "synthetic@example.test" }] },
      { phone_numbers: [{ id: 12, name: "Work", number: "4165550100" }] },
      { addresses: [{ id: 13, name: "Work", city: "Toronto" }] },
      { web_sites: [{ id: 14, name: "Work", address: "https://example.test" }] },
    ]) {
      const result = await handlers.create_contact({
        type: "Company", name: "Synthetic Company", ...nested,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("cannot include id when creating a contact");
    }
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("audits custom-field proposal errors raised during construction", async () => {
    const result = await getHandlers().create_contact({
      type: "Company", name: "Synthetic Company",
      custom_field_values: [
        { custom_field_id: 7001, value: "A" },
        { custom_field_id: 7001, value: "B" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("only once");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
  });

  it("previews and confirms an update against the current contact version", async () => {
    const current = {
      data: { id: 42, etag: "contact-v1", name: "Synthetic Co", type: "Company", updated_at: "2026-10-14T12:00:00Z" },
    };
    mockClioGet.mockResolvedValue(current);
    mockClioPatch.mockResolvedValue({ data: { ...current.data, phone_numbers: [{ number: "4165550100" }] } });
    const handlers = getHandlers();
    const args = { contact_id: 42, phone: "4165550100", confirm_write: false };
    const preview = JSON.parse((await handlers.update_contact(args)).content[0].text);
    expect(preview.proposal.current_updated_at).toBe(current.data.updated_at);

    const confirmed = await handlers.update_contact({
      ...args,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(JSON.parse(confirmed.content[0].text).write_performed).toBe(true);
    expect(mockClioPatch).toHaveBeenCalledWith("/contacts/42.json", {
      data: { phone_numbers: [{ name: "Work", number: "4165550100" }] },
    }, { "If-Match": "contact-v1" });
  });

  it("modifies existing entries by ID and preserves unspecified address fields", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 42, etag: "contact-v1", name: "Synthetic", type: "Person",
      email_addresses: [{ id: 11, name: "Home", default_email: true, address: "old@example.com" }],
      phone_numbers: [{ id: 12, name: "Home", number: "4165550000" }],
      addresses: [{ id: 13, name: "Home", street: "1 Test Street", city: "Toronto", country: "Canada" }],
    } });
    mockClioPatch.mockResolvedValue({ data: { id: 42 } });
    const handlers = getHandlers();
    const args = { contact_id: 42, email: "new@example.com", phone: "4165550100", city: "Ottawa" };
    const preview = JSON.parse((await handlers.update_contact(args)).content[0].text);
    await handlers.update_contact({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/contacts/42.json", { data: {
      email_addresses: [{ id: 11, name: "Home", default_email: true, address: "new@example.com" }],
      phone_numbers: [{ id: 12, name: "Home", number: "4165550100" }],
      addresses: [{ id: 13, name: "Home", street: "1 Test Street", city: "Ottawa", country: "Canada" }],
    } }, { "If-Match": "contact-v1" });
  });

  it("updates the selected website instead of creating a duplicate", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 42, etag: "contact-v1", name: "Synthetic", type: "Person",
      web_sites: [{ id: 21, name: "Work", address: "https://old.example.test", default_web_site: true }],
    } });
    const handlers = getHandlers();
    const preview = JSON.parse((await handlers.update_contact({
      contact_id: 42, web_site: "https://new.example.test",
    })).content[0].text);
    expect(preview.proposal.changes.web_sites).toEqual([{
      id: 21, name: "Work", address: "https://new.example.test", default_web_site: true,
    }]);
  });

  it("preserves every requested address update and validates IDs", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 42, etag: "contact-v1", name: "Synthetic", type: "Person",
      addresses: [
        { id: 31, name: "Work", street: "1 Old Street", city: "Toronto" },
        { id: 32, name: "Home", street: "2 Old Street", city: "Ottawa" },
      ],
    } });
    const preview = JSON.parse((await getHandlers().update_contact({
      contact_id: 42,
      addresses: [
        { id: 31, name: "Work", city: "Hamilton" },
        { id: 32, name: "Home", city: "Kingston" },
      ],
    })).content[0].text);
    expect(preview.proposal.changes.addresses).toEqual([
      { id: 31, name: "Work", street: "1 Old Street", city: "Hamilton" },
      { id: 32, name: "Home", street: "2 Old Street", city: "Kingston" },
    ]);
  });

  it("validates IDs in every plural contact association", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 42, etag: "contact-v1", name: "Synthetic", type: "Person",
      email_addresses: [{ id: 11, name: "Work", address: "old@example.test", default_email: true }],
      phone_numbers: [{ id: 12, name: "Mobile", number: "4165550000", default_number: true }],
      web_sites: [{ id: 13, name: "Work", address: "https://old.example.test", default_web_site: true }],
    } });
    const handlers = getHandlers();
    const preview = JSON.parse((await handlers.update_contact({
      contact_id: 42,
      email_addresses: [{ id: 11, name: "Work", address: "new@example.test" }],
      phone_numbers: [{ id: 12, name: "Mobile", number: "4165550100" }],
      web_sites: [{ id: 13, name: "Work", address: "https://new.example.test" }],
    })).content[0].text);
    expect(preview.proposal.changes).toMatchObject({
      email_addresses: [{ id: 11, address: "new@example.test", default_email: true }],
      phone_numbers: [{ id: 12, number: "4165550100", default_number: true }],
      web_sites: [{ id: 13, address: "https://new.example.test", default_web_site: true }],
    });

    for (const changes of [
      { email_addresses: [{ id: 999, name: "Work", address: "new@example.test" }] },
      { phone_numbers: [{ id: 999, name: "Mobile", number: "4165550100" }] },
      { web_sites: [{ id: 999, name: "Work", address: "https://new.example.test" }] },
    ]) {
      const result = await handlers.update_contact({ contact_id: 42, ...changes });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not belong to this contact");
    }
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects duplicate IDs in every plural contact association", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 42, etag: "contact-v1", name: "Synthetic", type: "Person",
      email_addresses: [{ id: 11, name: "Work", address: "old@example.test" }],
      phone_numbers: [{ id: 12, name: "Mobile", number: "4165550000" }],
      addresses: [{ id: 13, name: "Work", street: "1 Old Street" }],
      web_sites: [{ id: 14, name: "Work", address: "https://old.example.test" }],
    } });
    const handlers = getHandlers();
    const cases = [
      { email_addresses: [{ id: 11, address: "one@example.test" }, { id: 11, address: "two@example.test" }] },
      { phone_numbers: [{ id: 12, number: "4165550100" }, { id: 12, number: "4165550200" }] },
      { addresses: [{ id: 13, city: "Toronto" }, { id: 13, city: "Ottawa" }] },
      { web_sites: [{ id: 14, address: "https://one.example.test" }, { id: 14, address: "https://two.example.test" }] },
    ];
    for (const changes of cases) {
      const result = await handlers.update_contact({ contact_id: 42, ...changes });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ID may be supplied only once per mutation");
    }
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("preserves existing association labels and defaults only new entries to Work", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 42, etag: "contact-v1", name: "Synthetic", type: "Person",
      email_addresses: [{ id: 11, name: "Home", address: "old@example.test" }],
      phone_numbers: [{ id: 12, name: "Mobile", number: "4165550000" }],
      addresses: [{ id: 13, name: "Other", street: "1 Old Street" }],
      web_sites: [{ id: 14, name: "Personal", address: "https://old.example.test" }],
    } });
    const preview = JSON.parse((await getHandlers().update_contact({
      contact_id: 42,
      email_addresses: [{ id: 11, address: "new@example.test" }, { address: "new-work@example.test" }],
      phone_numbers: [{ id: 12, number: "4165550100" }, { number: "4165550200" }],
      addresses: [{ id: 13, city: "Toronto" }, { street: "2 New Street" }],
      web_sites: [{ id: 14, address: "https://new.example.test" }, { address: "https://work.example.test" }],
    })).content[0].text);
    expect(preview.proposal.changes).toMatchObject({
      email_addresses: [{ id: 11, name: "Home" }, { name: "Work" }],
      phone_numbers: [{ id: 12, name: "Mobile" }, { name: "Work" }],
      addresses: [{ id: 13, name: "Other" }, { name: "Work" }],
      web_sites: [{ id: 14, name: "Personal" }, { name: "Work" }],
    });
  });

  it("updates an existing custom field by its composite value ID", async () => {
    const current = { data: {
      id: 42, etag: "contact-v1", name: "Synthetic", type: "Person",
      custom_field_values: [{
        id: "text_line-7001", field_name: "Registry number", field_type: "text_line",
        value: "OLD", custom_field: { id: 7001 },
      }],
    } };
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/contacts/42.json") return current;
      if (requestPath === "/custom_fields/7001.json") return { data: {
        id: 7001, name: "Registry number", field_type: "text_line", parent_type: "Contact",
      } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    mockClioPatch.mockResolvedValue({ data: { id: 42 } });
    const handlers = getHandlers();
    const args = { contact_id: 42, custom_field_values: [{ custom_field_id: 7001, value: "NEW" }] };
    const preview = JSON.parse((await handlers.update_contact(args)).content[0].text);
    expect(preview.proposal.changes.custom_field_values).toEqual([
      { id: "text_line-7001", value: "NEW" },
    ]);
    await handlers.update_contact({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/contacts/42.json", { data: {
      custom_field_values: [{ id: "text_line-7001", value: "NEW" }],
    } }, { "If-Match": "contact-v1" });
  });

  it("rejects ambiguous entries unless an exact entry ID is supplied", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 42, etag: "v1", phone_numbers: [
        { id: 11, name: "Work", number: "4165550000" },
        { id: 12, name: "Work", number: "4165550001" },
      ],
    } });
    const handlers = getHandlers();
    const result = await handlers.update_contact({ contact_id: 42, phone: "4165550100" });
    expect(result.isError).toBe(true);
    const selected = await handlers.update_contact({ contact_id: 42, phone: "4165550100", phone_id: 12 });
    expect(JSON.parse(selected.content[0].text).proposal.changes.phone_numbers[0].id).toBe(12);
    const wrong = await handlers.update_contact({ contact_id: 42, phone: "4165550100", phone_id: 999 });
    expect(wrong.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects address_id when the plural addresses input is used", async () => {
    const result = await getHandlers().update_contact({
      contact_id: 42,
      address_id: 13,
      addresses: [{ name: "Work", city: "Toronto" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("selector requires changes to that entry");
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects a changed contact ETag before writing", async () => {
    const current = { id: 42, etag: "v1", name: "Synthetic" };
    mockClioGet.mockResolvedValue({ data: current });
    const handlers = getHandlers();
    const args = { contact_id: 42, title: "Director" };
    const preview = JSON.parse((await handlers.update_contact(args)).content[0].text);
    mockClioGet.mockResolvedValue({ data: { ...current, etag: "v2" } });
    const result = await handlers.update_contact({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects missing ETags and missing nested IDs", async () => {
    const handlers = getHandlers();
    mockClioGet.mockResolvedValue({ data: { id: 42 } });
    expect((await handlers.update_contact({ contact_id: 42, title: "Director" })).isError).toBe(true);
    mockClioGet.mockResolvedValue({ data: { id: 42, etag: "v1", phone_numbers: [{ name: "Work" }] } });
    expect((await handlers.update_contact({ contact_id: 42, phone: "4165550100" })).isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("scrubs API errors that echo intake data from mutation audits", async () => {
    mockClioGet.mockRejectedValue(new ClioApiError(422, "Invalid email: private@example.com"));
    await getHandlers().create_contact({ type: "Company", name: "Synthetic" });
    expect(JSON.stringify(mockAppendAuditLog.mock.calls)).not.toContain("private@example.com");
  });
});
