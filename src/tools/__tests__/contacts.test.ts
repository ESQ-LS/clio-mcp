import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const { mockClioGet, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet };
});
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { ClioApiError } from "../../utils/clioClient.js";
import { registerContactTools } from "../contacts.js";

function getHandler(): Function {
  const handlers: Record<string, Function> = {};
  const server = {
    registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; },
  } as unknown as McpServer;
  registerContactTools(server);
  return handlers.get_contact;
}

function contact(custom_field_values?: unknown) {
  return { data: { id: 42, name: "Synthetic Company", type: "Company", custom_field_values } };
}

beforeEach(() => vi.clearAllMocks());

describe("get_contact custom fields", () => {
  it("returns an empty array when custom fields are absent", async () => {
    mockClioGet.mockResolvedValue(contact());
    const result = await getHandler()({ contact_id: 42 });
    expect(JSON.parse(result.content[0].text).custom_field_values).toEqual([]);
  });

  it("returns definition ID, name, type, and value", async () => {
    mockClioGet.mockResolvedValue(contact([{
      id: "text_line-7001", field_name: "Synthetic Registry Number",
      field_type: "text_line", value: "SYN-123", custom_field: { id: 7001 },
    }]));
    const result = await getHandler()({ contact_id: 42 });
    expect(JSON.parse(result.content[0].text).custom_field_values).toEqual([{
      definition_id: 7001, name: "Synthetic Registry Number",
      value_type: "text_line", value: "SYN-123",
    }]);
    expect(mockClioGet.mock.calls[0][1].fields).toContain("custom_field_values{");
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      tool: "get_contact", args: { contact_id: 42 }, outcome: "success",
    });
  });

  it("fails closed on duplicate definitions", async () => {
    const field = { field_name: "Synthetic", field_type: "text_line", value: "A", custom_field: { id: 7001 } };
    mockClioGet.mockResolvedValue(contact([field, { ...field, value: "B" }]));
    const result = await getHandler()({ contact_id: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Duplicate");
  });

  it("fails closed on malformed custom fields", async () => {
    mockClioGet.mockResolvedValue(contact([{ field_name: "Synthetic", value: "A" }]));
    const result = await getHandler()({ contact_id: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Malformed");
  });

  it("returns an error on unauthorized access without logging field values", async () => {
    mockClioGet.mockRejectedValue(new ClioApiError(403, "Forbidden"));
    const result = await getHandler()({ contact_id: 42 });
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      tool: "get_contact", args: { contact_id: 42 }, outcome: "error", error_message: "Forbidden",
    });
    expect(JSON.stringify(mockAppendAuditLog.mock.calls)).not.toContain("custom_field_values");
  });
});
