import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioPost, mockClioPatch, mockClioGet, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => {
  class MockClioApiError extends Error {
    constructor(public statusCode: number, message: string) {
      super(message);
      this.name = "ClioApiError";
    }
  }
  return {
    mockClioPost: vi.fn(),
    mockClioPatch: vi.fn(),
    mockClioGet: vi.fn(),
    mockAppendAuditLog: vi.fn(),
    MockClioApiError,
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
  clioGet: mockClioGet,
  ClioApiError: MockClioApiError,
  getClioBaseUrl: () => "https://ca.app.clio.com/api/v4",
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: vi.fn(async () => ({ clio_user_id: "100", expires_at: Date.now() + 60000 })),
}));

import { registerMatterTools } from "../matters.js";

const handlers: Record<string, Function> = {};
beforeAll(() => {
  registerMatterTools({
    registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; },
  } as any);
});

const CLIENT = { data: { id: 1, name: "Synthetic Client", type: "Company" } };
const MATTER = {
  id: 42,
  etag: "matter-v1",
  display_number: "00042-001",
  description: "Synthetic intake",
  status: "pending",
  billable: true,
  client: CLIENT.data,
  open_date: "2026-10-14",
  updated_at: "2026-10-14T12:00:00Z",
};
const CREATE_ARGS = {
  client_id: 1,
  description: "Synthetic intake",
  status: "pending" as const,
  billable: true,
  open_date: "2026-10-14",
  confirm_write: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
  mockClioGet.mockResolvedValue(CLIENT);
  mockClioPost.mockResolvedValue({ data: MATTER });
  mockClioPatch.mockResolvedValue({ data: MATTER });
});

describe("controlled matter writes", () => {
  it("previews a pending matter without writing and confirms the unchanged proposal", async () => {
    const previewResult = await handlers.create_matter(CREATE_ARGS);
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.mode).toBe("dry_run");
    expect(preview.proposal).toMatchObject({
      client: { id: 1, name: "Synthetic Client" },
      description: "Synthetic intake",
      status: "pending",
      billable: true,
    });
    expect(mockClioPost).not.toHaveBeenCalled();

    const confirmed = await handlers.create_matter({
      ...CREATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(JSON.parse(confirmed.content[0].text)).toMatchObject({
      mode: "confirmed_write",
      write_performed: true,
      record_id: 42,
    });
    expect(mockClioPost).toHaveBeenCalledWith("/matters.json", {
      data: expect.objectContaining({ client: { id: 1 }, status: "pending" }),
    });
  });

  it("rejects a changed create proposal before any write", async () => {
    const preview = JSON.parse((await handlers.create_matter(CREATE_ARGS)).content[0].text);
    const result = await handlers.create_matter({
      ...CREATE_ARGS,
      description: "Changed after review",
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("proposal changed");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("includes routine assignment, lifecycle, deadline, and custom fields", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/contacts/1.json") return CLIENT;
      if (path === "/users/10.json") return { data: { id: 10, name: "Synthetic Staff", enabled: true } };
      if (path === "/matter_stages/20.json") return { data: { id: 20, name: "Intake" } };
      if (path === "/groups/30.json") return { data: { id: 30, name: "Firm" } };
      if (path === "/contacts/2.json") return { data: { id: 2, name: "Synthetic Related", type: "Person" } };
      throw new Error(`unexpected path ${path}`);
    });
    const args = {
      ...CREATE_ARGS,
      responsible_staff_id: 10,
      matter_stage_id: 20,
      group_id: 30,
      location: "Toronto",
      pending_date: "2026-10-14",
      statute_of_limitations_due_at: "2027-10-14",
      statute_of_limitations_status: "pending" as const,
      custom_field_values: [{ custom_field_id: 8001, value: "SYN-MATTER" }],
      relationships: [{ contact_id: 2, description: "Primary contact" }],
    };
    const preview = JSON.parse((await handlers.create_matter(args)).content[0].text);
    await handlers.create_matter({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/matters.json", { data: expect.objectContaining({
      responsible_staff: { id: 10 }, matter_stage: { id: 20 }, group: { id: 30 },
      location: "Toronto", pending_date: "2026-10-14",
      statute_of_limitations: { due_at: "2027-10-14", status: "pending" },
      custom_field_values: [{ custom_field: { id: 8001 }, value: "SYN-MATTER" }],
      relationships: [{ contact: { id: 2 }, description: "Primary contact" }],
    }) });
  });

  it("previews and confirms an update against the current matter version", async () => {
    mockClioGet.mockResolvedValue({ data: MATTER });
    const args = { matter_id: 42, status: "open" as const, confirm_write: false };
    const preview = JSON.parse((await handlers.update_matter(args)).content[0].text);
    expect(preview.proposal.current_updated_at).toBe(MATTER.updated_at);
    expect(mockClioPatch).not.toHaveBeenCalled();

    const confirmed = await handlers.update_matter({
      ...args,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(JSON.parse(confirmed.content[0].text).write_performed).toBe(true);
    expect(mockClioPatch).toHaveBeenCalledWith("/matters/42.json", { data: { status: "open" } }, { "If-Match": "matter-v1" });
  });

  it("fails closed when audit persistence fails", async () => {
    mockAppendAuditLog.mockResolvedValue(false);
    const result = await handlers.create_matter(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects a changed matter ETag before writing", async () => {
    mockClioGet.mockResolvedValue({ data: MATTER });
    const args = { matter_id: 42, status: "open" };
    const preview = JSON.parse((await handlers.update_matter(args)).content[0].text);
    mockClioGet.mockResolvedValue({ data: { ...MATTER, etag: "matter-v2" } });
    const result = await handlers.update_matter({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("uses If-Match to reject an edit racing with the final PATCH", async () => {
    mockClioGet.mockResolvedValue({ data: MATTER });
    const args = { matter_id: 42, status: "open" };
    const preview = JSON.parse((await handlers.update_matter(args)).content[0].text);
    mockClioPatch.mockRejectedValue(new MockClioApiError(412, "Precondition failed"));
    const result = await handlers.update_matter({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).toBe(true);
    expect(mockClioPatch).toHaveBeenCalledWith("/matters/42.json", { data: { status: "open" } }, { "If-Match": "matter-v1" });
    expect(JSON.parse(result.content[0].text).error).toContain("412");
  });

  it("refuses updates when Clio omits an ETag", async () => {
    mockClioGet.mockResolvedValue({ data: { ...MATTER, etag: undefined } });
    const result = await handlers.update_matter({ matter_id: 42, status: "open" });
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });
});
