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

import { firmCalendarDate, registerMatterTools } from "../matters.js";

const handlers: Record<string, Function> = {};
const toolConfigs: Record<string, any> = {};
beforeAll(() => {
  registerMatterTools({
    registerTool: (name: string, config: unknown, handler: Function) => {
      handlers[name] = handler;
      toolConfigs[name] = config;
    },
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
  practice_area: { id: 5, name: "Synthetic practice" },
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
  delete process.env.ESQ_FIRM_TIMEZONE;
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
  mockClioGet.mockResolvedValue(CLIENT);
  mockClioPost.mockResolvedValue({ data: MATTER });
  mockClioPatch.mockResolvedValue({ data: MATTER });
});

describe("controlled matter writes", () => {
  it("derives lifecycle dates in the configured firm timezone", () => {
    process.env.ESQ_FIRM_TIMEZONE = "America/Toronto";
    expect(firmCalendarDate(new Date("2026-10-24T01:00:00Z"))).toBe("2026-10-23");
  });

  it("returns and audits a structured error for an invalid firm timezone", async () => {
    process.env.ESQ_FIRM_TIMEZONE = "Invalid/Synthetic";
    const result = await handlers.create_matter({
      client_id: 1,
      description: "Synthetic pending intake",
      status: "pending",
      billable: true,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ write_performed: false });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_matter", outcome: "error",
    }));
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("returns and audits structured errors for duplicate matter custom fields", async () => {
    const custom_field_values = [
      { custom_field_id: 8001, value: "A" },
      { custom_field_id: 8001, value: "B" },
    ];
    const created = await handlers.create_matter({ ...CREATE_ARGS, custom_field_values });
    const updated = await handlers.update_matter({ matter_id: 42, custom_field_values });
    expect(created.isError).toBe(true);
    expect(updated.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_matter", outcome: "error",
    }));
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "update_matter", outcome: "error",
    }));
    expect(mockClioPost).not.toHaveBeenCalled();
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("requests pending_date when listing matters", async () => {
    mockClioGet.mockResolvedValue({ data: [{ id: 42, status: "pending", pending_date: "2026-10-23" }] });
    await handlers.list_matters({ limit: 25 });
    expect(mockClioGet.mock.calls[0][1].fields).toContain("pending_date");
  });

  it("returns pending_date when reading a matter", async () => {
    mockClioGet.mockResolvedValue({ data: { ...MATTER, pending_date: "2026-10-23" } });
    const result = JSON.parse((await handlers.get_matter({ matter_id: 42 })).content[0].text);
    expect(result.pending_date).toBe("2026-10-23");
  });

  it("does not request unsupported second-level field expansions", async () => {
    mockClioGet.mockResolvedValue({ data: MATTER });
    await handlers.get_matter({ matter_id: 42 });
    const fields = mockClioGet.mock.calls[0][1].fields as string;
    expect(fields).toContain("relationships{id,description,contact}");
    expect(fields).toContain("custom_field_values{id,field_name,field_type,value,custom_field}");
    expect(fields).not.toContain("contact{id,name}");
    expect(fields).not.toContain("custom_field{id}");
  });
  it("defaults a pending intake to pending_date without inventing open_date", async () => {
    const args = {
      client_id: 1,
      description: "Synthetic pending intake",
      status: "pending" as const,
      billable: true,
      confirm_write: false,
    };
    const preview = JSON.parse((await handlers.create_matter(args)).content[0].text);
    expect(preview.proposal.pending_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(preview.proposal).not.toHaveProperty("open_date");
  });

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
      if (path === "/practice_areas/5.json") return { data: { id: 5, name: "Synthetic practice" } };
      if (path === "/contacts/2.json") return { data: { id: 2, name: "Synthetic Related", type: "Person" } };
      if (path === "/custom_fields/8001.json") return { data: {
        id: 8001, name: "Internal code", field_type: "text_line", parent_type: "Matter",
      } };
      throw new Error(`unexpected path ${path}`);
    });
    const args = {
      ...CREATE_ARGS,
      responsible_staff_id: 10,
      practice_area_id: 5,
      location: "Toronto",
      require_utbms_codes: true,
      pending_date: "2026-10-14",
      statute_of_limitations_due_at: "2027-10-14",
      statute_of_limitations_status: "pending" as const,
      custom_field_values: [{ custom_field_id: 8001, value: "SYN-MATTER" }],
      relationships: [{ contact_id: 2, description: "Primary contact" }],
    };
    const preview = JSON.parse((await handlers.create_matter(args)).content[0].text);
    expect(preview.proposal.custom_field_value_details).toEqual([{
      custom_field: {
        id: 8001, name: "Internal code", field_type: "text_line", parent_type: "Matter",
      },
      value: "SYN-MATTER",
    }]);
    await handlers.create_matter({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/matters.json", { data: expect.objectContaining({
      responsible_staff: { id: 10 }, practice_area: { id: 5 },
      location: "Toronto", pending_date: "2026-10-14", require_utbms_codes: true,
      statute_of_limitations: { due_at: "2027-10-14", status: "pending" },
      custom_field_values: [{ custom_field: { id: 8001 }, value: "SYN-MATTER" }],
      relationships: [{ contact: { id: 2 }, description: "Primary contact" }],
    }) });
  });

  it("rejects matter permission-group changes from routine create and update writes", async () => {
    expect(toolConfigs.create_matter.inputSchema).not.toHaveProperty("group_id");
    expect(toolConfigs.update_matter.inputSchema).not.toHaveProperty("group_id");
    const created = await handlers.create_matter({ ...CREATE_ARGS, group_id: 30 });
    const updated = await handlers.update_matter({ matter_id: 42, group_id: 30 });
    for (const result of [created, updated]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("changes matter permissions");
    }
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects matter-stage mutations before previewing or reading Clio", async () => {
    const created = await handlers.create_matter({ ...CREATE_ARGS, matter_stage_id: 20 });
    const updated = await handlers.update_matter({ matter_id: 42, matter_stage_id: 20 });
    for (const result of [created, updated]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("notify clients or trigger automated workflows");
      expect(result.content[0].text).not.toContain("preview_token");
    }
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("deduplicates repeated relationship contact validation lookups", async () => {
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/contacts/1.json") return CLIENT;
      if (requestPath === "/contacts/2.json") return { data: { id: 2, name: "Synthetic Related", type: "Person" } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    await handlers.create_matter({
      ...CREATE_ARGS,
      relationships: [
        { contact_id: 2, description: "Primary contact" },
        { contact_id: 2, description: "Billing contact" },
      ],
    });
    expect(mockClioGet.mock.calls.filter(([requestPath]) => requestPath === "/contacts/2.json")).toHaveLength(1);
  });

  it("previews and confirms an update against the current matter version", async () => {
    mockClioGet.mockResolvedValue({ data: MATTER });
    const args = { matter_id: 42, status: "open" as const, confirm_write: false };
    const preview = JSON.parse((await handlers.update_matter(args)).content[0].text);
    expect(preview.proposal.current_updated_at).toBe(MATTER.updated_at);
    expect(preview.proposal.changes.open_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockClioPatch).not.toHaveBeenCalled();

    const confirmed = await handlers.update_matter({
      ...args,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(JSON.parse(confirmed.content[0].text).write_performed).toBe(true);
    expect(mockClioPatch).toHaveBeenCalledWith("/matters/42.json", { data: {
      status: "open", open_date: preview.proposal.changes.open_date,
    } }, { "If-Match": "matter-v1" });
  });

  it("binds the matching lifecycle date into every status-transition preview", async () => {
    for (const transition of [
      { current: "pending", status: "open", date: "open_date" },
      { current: "open", status: "pending", date: "pending_date" },
      { current: "open", status: "closed", date: "close_date" },
    ] as const) {
      mockClioGet.mockResolvedValue({ data: { ...MATTER, status: transition.current } });
      const preview = JSON.parse((await handlers.update_matter({
        matter_id: 42, status: transition.status,
      })).content[0].text);
      expect(preview.proposal.changes[transition.date]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("preserves an explicit lifecycle date on a status transition", async () => {
    mockClioGet.mockResolvedValue({ data: { ...MATTER, status: "open" } });
    const preview = JSON.parse((await handlers.update_matter({
      matter_id: 42, status: "closed", close_date: "2026-10-01",
    })).content[0].text);
    expect(preview.proposal.changes.close_date).toBe("2026-10-01");
  });

  it("does not overwrite a lifecycle date when Clio returns title-case status", async () => {
    mockClioGet.mockResolvedValue({ data: { ...MATTER, status: "Open", open_date: "2025-01-15" } });
    const preview = JSON.parse((await handlers.update_matter({
      matter_id: 42, status: "open",
    })).content[0].text);
    expect(preview.proposal.changes).toEqual({ status: "open" });
    expect(preview.proposal.changes).not.toHaveProperty("open_date");
  });

  it("requires and forwards the matter-number reset control for display-number updates", async () => {
    mockClioGet.mockResolvedValue({ data: MATTER });
    const rejected = await handlers.update_matter({ matter_id: 42, display_number: "SYN-0042" });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("reset_matter_number must be true");
    expect(mockClioGet).not.toHaveBeenCalled();

    const args = { matter_id: 42, display_number: "SYN-0042", reset_matter_number: true };
    const preview = JSON.parse((await handlers.update_matter(args)).content[0].text);
    expect(preview.proposal.changes).toMatchObject({
      display_number: "SYN-0042", reset_matter_number: true,
    });
    await handlers.update_matter({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/matters/42.json", { data: {
      display_number: "SYN-0042", reset_matter_number: true,
    } }, { "If-Match": "matter-v1" });
  });

  it("updates an existing custom field by its composite value ID", async () => {
    const current = {
      ...MATTER,
      custom_field_values: [{
        id: "text_line-8001", field_name: "Internal code", field_type: "text_line",
        value: "OLD", custom_field: { id: 8001 },
      }],
    };
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/matters/42.json") return { data: current };
      if (requestPath === "/custom_fields/8001.json") return { data: {
        id: 8001, name: "Internal code", field_type: "text_line", parent_type: "Matter",
      } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    const args = { matter_id: 42, custom_field_values: [{ custom_field_id: 8001, value: "NEW" }] };
    const preview = JSON.parse((await handlers.update_matter(args)).content[0].text);
    expect(preview.proposal.changes.custom_field_values).toEqual([
      { id: "text_line-8001", value: "NEW" },
    ]);
    await handlers.update_matter({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/matters/42.json", { data: {
      custom_field_values: [{ id: "text_line-8001", value: "NEW" }],
    } }, { "If-Match": "matter-v1" });
  });

  it("updates only a relationship proven to belong to the current matter and contact", async () => {
    const current = {
      ...MATTER,
      relationships: [{ id: 501, description: "Old role", contact: { id: 2, name: "Synthetic Related" } }],
    };
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/42.json") return { data: current };
      if (path === "/contacts/2.json") return { data: { id: 2, name: "Synthetic Related", type: "Person" } };
      throw new Error(`unexpected path ${path}`);
    });
    const args = {
      matter_id: 42,
      relationships: [{ id: 501, contact_id: 2, description: "Updated role" }],
    };
    const preview = JSON.parse((await handlers.update_matter(args)).content[0].text);
    await handlers.update_matter({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/matters/42.json", { data: {
      relationships: [{ id: 501, contact: { id: 2 }, description: "Updated role" }],
    } }, { "If-Match": "matter-v1" });
  });

  it("rejects duplicate existing relationship IDs before preview authorization", async () => {
    const current = {
      ...MATTER,
      relationships: [{ id: 501, description: "Old role", contact: { id: 2, name: "Synthetic Related" } }],
    };
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/matters/42.json") return { data: current };
      if (requestPath === "/contacts/2.json") return { data: { id: 2, name: "Synthetic Related", type: "Person" } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await handlers.update_matter({
      matter_id: 42,
      relationships: [
        { id: 501, contact_id: 2, description: "Primary contact" },
        { id: 501, contact_id: 2, description: "Billing contact" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("relationship ID may be supplied only once");
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects foreign relationship IDs and relationship IDs on creation", async () => {
    const current = {
      ...MATTER,
      relationships: [{ id: 501, description: "Old role", contact: { id: 2, name: "Synthetic Related" } }],
    };
    mockClioGet.mockResolvedValue({ data: current });
    const foreign = await handlers.update_matter({
      matter_id: 42,
      relationships: [{ id: 999, contact_id: 2, description: "Updated role" }],
    });
    expect(foreign.isError).toBe(true);

    mockClioGet.mockResolvedValue(CLIENT);
    const createWithId = await handlers.create_matter({
      ...CREATE_ARGS,
      relationships: [{ id: 501, contact_id: 2, description: "Primary contact" }],
    });
    expect(createWithId.isError).toBe(true);
    expect(mockClioPost).not.toHaveBeenCalled();
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
    expect(mockClioPatch).toHaveBeenCalledWith("/matters/42.json", { data: {
      status: "open", open_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    } }, { "If-Match": "matter-v1" });
    expect(JSON.parse(result.content[0].text).error).toContain("412");
  });

  it("refuses updates when Clio omits an ETag", async () => {
    mockClioGet.mockResolvedValue({ data: { ...MATTER, etag: undefined } });
    const result = await handlers.update_matter({ matter_id: 42, status: "open" });
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });
});
