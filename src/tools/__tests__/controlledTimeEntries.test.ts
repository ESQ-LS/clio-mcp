import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioGet, mockClioPost, mockClioPatch, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockClioPatch: vi.fn(),
  mockAppendAuditLog: vi.fn(),
}));

vi.mock("../../utils/clioClient.js", () => ({
  ClioApiError: class ClioApiError extends Error {
    constructor(public statusCode: number, message: string) { super(message); }
  },
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
}));

vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerControlledTimeEntryTools } from "../controlledTimeEntries.js";

type Handler = (args: Record<string, any>) => Promise<any>;

const MATTER = {
  id: 101,
  display_number: "SYNTH-0001",
  status: "Open",
  billable: true,
  require_utbms_codes: false,
};
const USER = { id: 7, name: "Synthetic Lawyer", enabled: true, subscription_type: "Attorney", rate: 500 };
const DESCRIPTION = { id: 8, name: "Billable", default: true, rate: 500 };
const CURRENT_ENTRY = {
  id: 99,
  etag: '"etag-current"',
  type: "TimeEntry",
  date: "2026-08-01",
  quantity_in_hours: 1,
  price: 500,
  total: 500,
  note: "Review synthetic transaction documents.",
  billed: false,
  on_bill: false,
  non_billable: false,
  no_charge: false,
  matter: { id: 101, display_number: "SYNTH-0001" },
  user: { id: 7, name: "Synthetic Lawyer" },
  activity_description: { id: 8, name: "Billable" },
};

function buildServer(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _schema: unknown, handler: Handler) => { handlers[name] = handler; },
  } as unknown as McpServer;
  registerControlledTimeEntryTools(server);
  return handlers;
}

function installValidReads(entry = CURRENT_ENTRY): void {
  mockClioGet.mockImplementation(async (path: string) => {
    if (path === "/activities/99.json") return { data: entry };
    if (path === "/matters/101.json") return { data: MATTER };
    if (path === "/users/7.json") return { data: USER };
    if (path === "/activity_descriptions/8.json") return { data: DESCRIPTION };
    throw new Error(`Unexpected synthetic path: ${path}`);
  });
}

const CREATE_ARGS = {
  matter_id: 101,
  date: "2026-08-01",
  user_id: 7,
  quantity_in_hours: 1.2,
  rate: 500,
  billing_status: "billable",
  narrative: "Review synthetic transaction documents and advise.",
  activity_description_id: 8,
  supporting_evidence: "Synthetic calendar and email fixture ESQ-001.",
  confirm_write: false,
};

const UPDATE_ARGS = {
  activity_id: 99,
  etag: '"etag-current"',
  narrative: "Revise synthetic transaction documents and advise.",
  supporting_evidence: "Synthetic document-version fixture ESQ-002.",
  confirm_write: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
  installValidReads();
  mockClioPost.mockResolvedValue({
    data: {
      ...CURRENT_ENTRY,
      id: 100,
      etag: '"etag-created"',
      quantity_in_hours: 1.2,
      note: CREATE_ARGS.narrative,
    },
  });
  mockClioPatch.mockResolvedValue({
    data: { ...CURRENT_ENTRY, etag: '"etag-updated"', note: UPDATE_ARGS.narrative },
  });
});

describe("create_time_entry", () => {
  it("returns a complete dry-run preview without writing", async () => {
    const handlers = buildServer();
    const result = await handlers.create_time_entry(CREATE_ARGS);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      mode: "dry_run",
      write_performed: false,
      action: "create",
      proposal: {
        matter: { id: 101, display_number: "SYNTH-0001" },
        date: "2026-08-01",
        lawyer: { id: 7, name: "Synthetic Lawyer" },
        duration_hours: 1.2,
        rate: 500,
        billing_status: "billable",
        narrative: CREATE_ARGS.narrative,
      },
    });
    expect(body.preview_token).toBeTypeOf("string");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("requires the unchanged dry-run token before a confirmed creation", async () => {
    const handlers = buildServer();
    const preview = JSON.parse((await handlers.create_time_entry(CREATE_ARGS)).content[0].text);
    const result = await handlers.create_time_entry({
      ...CREATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ mode: "confirmed_write", write_performed: true, record_id: 100 });
    expect(mockClioPost).toHaveBeenCalledOnce();
    expect(mockClioPost).toHaveBeenCalledWith("/activities.json", {
      data: expect.objectContaining({
        type: "TimeEntry",
        matter: { id: 101 },
        user: { id: 7 },
        activity_description: { id: 8 },
        quantity: 4320,
        price: 500,
        note: CREATE_ARGS.narrative,
        non_billable: false,
      }),
    });
  });

  it("rejects a direct confirmed call without a preview token", async () => {
    const handlers = buildServer();
    const result = await handlers.create_time_entry({ ...CREATE_ARGS, confirm_write: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/preview_token is required/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects an invalid matter before writing", async () => {
    mockClioGet.mockRejectedValueOnce(new Error("synthetic 404"));
    const handlers = buildServer();
    const result = await handlers.create_time_entry(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("returns an error without fabricating success when the Clio API fails", async () => {
    const handlers = buildServer();
    const preview = JSON.parse((await handlers.create_time_entry(CREATE_ARGS)).content[0].text);
    mockClioPost.mockRejectedValueOnce(new Error("synthetic network failure"));
    const result = await handlers.create_time_entry({
      ...CREATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).write_performed).toBe("unknown");
  });

  it("never puts the narrative or supporting evidence in audit arguments", async () => {
    const handlers = buildServer();
    await handlers.create_time_entry(CREATE_ARGS);
    const auditText = JSON.stringify(mockAppendAuditLog.mock.calls);
    expect(auditText).not.toContain(CREATE_ARGS.narrative);
    expect(auditText).not.toContain(CREATE_ARGS.supporting_evidence);
  });
});

describe("update_time_entry", () => {
  it("previews the merged entry and does not patch on dry-run", async () => {
    const handlers = buildServer();
    const result = await handlers.update_time_entry(UPDATE_ARGS);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      mode: "dry_run",
      write_performed: false,
      proposal: {
        record_id: 99,
        current_etag: '"etag-current"',
        matter: { id: 101 },
        lawyer: { id: 7 },
        duration_hours: 1,
        rate: 500,
        billing_status: "billable",
        narrative: UPDATE_ARGS.narrative,
        fields_changed: ["narrative"],
      },
    });
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("patches an unchanged unbilled entry with If-Match after confirmation", async () => {
    const handlers = buildServer();
    const preview = JSON.parse((await handlers.update_time_entry(UPDATE_ARGS)).content[0].text);
    const result = await handlers.update_time_entry({
      ...UPDATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(result.isError).toBeUndefined();
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/activities/99.json",
      { data: { note: UPDATE_ARGS.narrative } },
      { "If-Match": '"etag-current"' },
    );
  });

  it("rejects reuse of a consumed preview token", async () => {
    const handlers = buildServer();
    const preview = JSON.parse((await handlers.update_time_entry(UPDATE_ARGS)).content[0].text);
    const confirmed = {
      ...UPDATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    };
    await handlers.update_time_entry(confirmed);
    mockClioPatch.mockClear();
    const second = await handlers.update_time_entry(confirmed);
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0].text).error).toMatch(/already been used/);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects a stale ETag", async () => {
    installValidReads({ ...CURRENT_ENTRY, etag: '"etag-new"' });
    const handlers = buildServer();
    const result = await handlers.update_time_entry(UPDATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/changed after it was retrieved/);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("rejects billed entries", async () => {
    installValidReads({ ...CURRENT_ENTRY, billed: true });
    const handlers = buildServer();
    const result = await handlers.update_time_entry(UPDATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/Billed or invoiced/);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("requires an explicit rate when changing a rate-determining reference", async () => {
    const handlers = buildServer();
    const result = await handlers.update_time_entry({
      ...UPDATE_ARGS,
      narrative: undefined,
      user_id: 7,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/explicit rate is required/);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("blocks a confirmed write when the pre-write audit cannot be persisted", async () => {
    const handlers = buildServer();
    const preview = JSON.parse((await handlers.update_time_entry(UPDATE_ARGS)).content[0].text);
    mockAppendAuditLog.mockResolvedValueOnce(false).mockResolvedValue(true);
    const result = await handlers.update_time_entry({
      ...UPDATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/Audit persistence failed/);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });
});
