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

  it("previews and confirms an update against the current contact version", async () => {
    const current = {
      data: { id: 42, name: "Synthetic Co", type: "Company", updated_at: "2026-10-14T12:00:00Z" },
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
    });
  });
});
