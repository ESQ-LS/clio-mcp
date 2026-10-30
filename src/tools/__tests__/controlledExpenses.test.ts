import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioGet, mockClioPost, mockClioPatch, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockClioPatch: vi.fn(),
  mockAppendAuditLog: vi.fn(),
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
  extractNextPageToken: (meta: any) => meta?.next_page_token ?? null,
  ClioApiError: class ClioApiError extends Error {
    constructor(public statusCode: number, message: string) { super(message); }
  },
  getClioBaseUrl: () => "https://ca.app.clio.com/api/v4",
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("../../auth/tokenStorage.js", () => ({
  getEncryptionKey: vi.fn(async () => Buffer.from("a".repeat(64), "hex")),
  loadTokens: vi.fn(async () => ({ clio_user_id: "42", expires_at: Date.now() + 24 * 60 * 60 * 1000 })),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerControlledExpenseTools } from "../controlledExpenses.js";

type Handler = (args: Record<string, any>) => Promise<any>;

const MATTER = {
  id: 101,
  display_number: "SYNTH-0001",
  status: "Open",
  billable: true,
  billing_method: "hourly",
  require_utbms_codes: false,
  redacted: false,
};
const CATEGORY = {
  id: 77,
  name: "Synthetic filing fee",
  entry_type: "unassociated",
  accessible_to_user: true,
  redacted: false,
  tax_setting: "no_tax",
};
const CURRENT = {
  id: 501,
  etag: '"expense-etag"',
  type: "ExpenseEntry",
  date: "2026-10-01",
  quantity: 1,
  price: 125,
  total: 125,
  note: "Synthetic registry fee.\n\nSource reference: SYN-INV-001",
  billed: false,
  on_bill: false,
  non_billable: false,
  no_charge: false,
  tax_setting: "no_tax",
  matter: { id: 101, display_number: "SYNTH-0001" },
  expense_category: { id: 77, name: "Synthetic filing fee", entry_type: "unassociated" },
};

const CREATE_ARGS = {
  matter_id: 101,
  allocation_matter_id: 101,
  date: "2026-10-01",
  amount: 125,
  expense_category_id: 77,
  description: "Synthetic registry fee.",
  source_reference: "SYN-INV-001",
  billing_status: "billable",
  tax_setting: "no_tax",
  cost_type: "client_recoverable_direct_cost",
  confirm_write: false,
};

function buildHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  registerControlledExpenseTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; },
  } as unknown as McpServer);
  return handlers;
}

function installReads(entry = CURRENT, matter = MATTER): void {
  mockClioGet.mockImplementation(async (path: string) => {
    if (path === "/matters/101.json") return { data: matter };
    if (path === "/expense_categories/77.json") return { data: CATEGORY };
    if (path === "/activities/501.json") return { data: entry };
    if (path === "/activities.json") return { data: [] };
    throw new Error(`Unexpected synthetic path: ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
  installReads();
  mockClioPost.mockResolvedValue({ data: { ...CURRENT, id: 502, etag: '"created"' } });
  mockClioPatch.mockResolvedValue({ data: { ...CURRENT, etag: '"updated"', price: 150 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("expense reads", () => {
  it("lists only ExpenseEntry activities with cursor metadata", async () => {
    mockClioGet.mockResolvedValueOnce({ data: [CURRENT], meta: { next_page_token: "next-expense" } });
    const result = await buildHandlers().list_expense_entries({ status: "unbilled", limit: 1 });
    const body = JSON.parse(result.content[0].text);
    expect(mockClioGet).toHaveBeenCalledWith("/activities.json", expect.objectContaining({
      type: "ExpenseEntry", status: "unbilled", limit: "1",
    }));
    expect(body).toMatchObject({ has_more: true, next_page_token: "next-expense" });
    expect(body.entries[0]).toMatchObject({
      id: 501,
      etag: '"expense-etag"',
      amount: 125,
      description: "Synthetic registry fee.",
      source_reference: "SYN-INV-001",
    });
  });

  it("gets one exact ExpenseEntry and rejects a different activity type", async () => {
    const handlers = buildHandlers();
    const ok = await handlers.get_expense_entry({ activity_id: 501 });
    expect(JSON.parse(ok.content[0].text)).toMatchObject({ id: 501, type: "ExpenseEntry" });
    installReads({ ...CURRENT, type: "TimeEntry" });
    const rejected = await handlers.get_expense_entry({ activity_id: 501 });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content[0].text).error).toMatch(/not an ExpenseEntry/);
  });
});

describe("create_expense_entry", () => {
  it("returns a validated dry-run without writing or audit-logging confidential fields", async () => {
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      mode: "dry_run",
      write_performed: false,
      action: "create_expense_entry",
      proposal: {
        matter: { id: 101, display_number: "SYNTH-0001" },
        allocation_matter_id: 101,
        amount: 125,
        expense_category: { id: 77, name: "Synthetic filing fee" },
        billing_status: "billable",
        tax_setting: "no_tax",
      },
    });
    expect(body.preview_token).toBeTypeOf("string");
    expect(mockClioPost).not.toHaveBeenCalled();
    const audit = JSON.stringify(mockAppendAuditLog.mock.calls);
    expect(audit).not.toContain(CREATE_ARGS.description);
    expect(audit).not.toContain(CREATE_ARGS.source_reference);
    expect(audit).not.toContain(String(CREATE_ARGS.amount));
  });

  it("requires an unchanged preview token and writes the exact ExpenseEntry payload", async () => {
    const handlers = buildHandlers();
    const preview = JSON.parse((await handlers.create_expense_entry(CREATE_ARGS)).content[0].text);
    const result = await handlers.create_expense_entry({
      ...CREATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(result.isError).not.toBe(true);
    expect(mockClioPost).toHaveBeenCalledWith(
      expect.stringMatching(/^\/activities\.json\?fields=/),
      { data: {
        type: "ExpenseEntry",
        date: "2026-10-01",
        quantity: 1,
        price: 125,
        note: "Synthetic registry fee.\n\nSource reference: SYN-INV-001",
        non_billable: false,
        no_charge: false,
        tax_setting: "no_tax",
        matter: { id: 101 },
        expense_category: { id: 77 },
      } },
    );
  });

  it("rejects cross-matter allocation before any Clio request", async () => {
    const result = await buildHandlers().create_expense_entry({ ...CREATE_ARGS, allocation_matter_id: 202 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/Cross-matter allocation rejected/);
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects an invalid expense category", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/101.json") return { data: MATTER };
      if (path === "/expense_categories/77.json") return { data: { id: 88 } };
      throw new Error("unexpected");
    });
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/Expense-category validation failed/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...CATEGORY, entry_type: "hard_cost" }, /Only unassociated expense categories/],
    [{ ...CATEGORY, entry_type: "soft_cost" }, /Only unassociated expense categories/],
    [{ ...CATEGORY, accessible_to_user: false }, /category is not accessible/],
    [{ ...CATEGORY, redacted: true }, /category is not accessible/],
  ])("rejects an incompatible or inaccessible expense category", async (category, expectedError) => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/101.json") return { data: MATTER };
      if (path === "/expense_categories/77.json") return { data: category };
      throw new Error("unexpected");
    });
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(expectedError);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects a redacted matter before duplicate screening or write", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/101.json") return { data: { ...MATTER, redacted: true } };
      throw new Error("unexpected");
    });
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/cannot access the full matter/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it.each(["flat_rate", "contingency"])("allows billable expenses for UTBMS-exempt %s matters", async (billingMethod) => {
    installReads(CURRENT, { ...MATTER, require_utbms_codes: true, billing_method: billingMethod });
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ mode: "dry_run" });
  });

  it("still rejects billable expenses when an hourly matter requires UTBMS codes", async () => {
    installReads(CURRENT, { ...MATTER, require_utbms_codes: true, billing_method: "hourly" });
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/requires a UTBMS expense code/);
  });

  it("rejects a duplicate at preview", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/101.json") return { data: MATTER };
      if (path === "/expense_categories/77.json") return { data: CATEGORY };
      if (path === "/activities.json") return { data: [CURRENT] };
      throw new Error("unexpected");
    });
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/Duplicate expense rejected/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects the same source reference even when the description changed", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/101.json") return { data: MATTER };
      if (path === "/expense_categories/77.json") return { data: CATEGORY };
      if (path === "/activities.json") {
        return { data: [{ ...CURRENT, note: "Different description.\n\nSource reference:  syn-inv-001  " }] };
      }
      throw new Error("unexpected");
    });
    const result = await buildHandlers().create_expense_entry(CREATE_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/Duplicate expense rejected/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rechecks idempotency at confirmation and rejects a duplicate that appeared after preview", async () => {
    let activityLists = 0;
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/101.json") return { data: MATTER };
      if (path === "/expense_categories/77.json") return { data: CATEGORY };
      if (path === "/activities.json") {
        activityLists++;
        return { data: activityLists >= 3 ? [CURRENT] : [] };
      }
      throw new Error("unexpected");
    });
    const handlers = buildHandlers();
    const preview = JSON.parse((await handlers.create_expense_entry(CREATE_ARGS)).content[0].text);
    const result = await handlers.create_expense_entry({
      ...CREATE_ARGS,
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/appeared after preview/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects missing, invalid, and expired preview tokens", async () => {
    const handlers = buildHandlers();
    const missing = await handlers.create_expense_entry({ ...CREATE_ARGS, confirm_write: true });
    expect(JSON.parse(missing.content[0].text).error).toMatch(/preview_token is required/);

    const invalid = await handlers.create_expense_entry({
      ...CREATE_ARGS, confirm_write: true, preview_token: "invalid.token",
    });
    expect(JSON.parse(invalid.content[0].text).error).toMatch(/Invalid preview token/);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const preview = JSON.parse((await handlers.create_expense_entry(CREATE_ARGS)).content[0].text);
    vi.setSystemTime(new Date("2026-10-01T12:16:00Z"));
    const expired = await handlers.create_expense_entry({
      ...CREATE_ARGS, confirm_write: true, preview_token: preview.preview_token,
    });
    expect(JSON.parse(expired.content[0].text).error).toMatch(/expired/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });
});

describe("update_expense_entry", () => {
  const UPDATE_ARGS = {
    activity_id: 501,
    etag: '"expense-etag"',
    allocation_matter_id: 101,
    amount: 150,
    cost_type: "client_recoverable_direct_cost",
    confirm_write: false,
  };

  it("previews and patches an unchanged unbilled entry using If-Match", async () => {
    const handlers = buildHandlers();
    const preview = JSON.parse((await handlers.update_expense_entry(UPDATE_ARGS)).content[0].text);
    expect(preview).toMatchObject({
      mode: "dry_run",
      proposal: { record_id: 501, amount: 150, fields_changed: ["amount"] },
    });
    const result = await handlers.update_expense_entry({
      ...UPDATE_ARGS, confirm_write: true, preview_token: preview.preview_token,
    });
    expect(result.isError).not.toBe(true);
    expect(mockClioPatch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/activities\/501\.json\?fields=/),
      { data: { price: 150 } },
      { "If-Match": '"expense-etag"' },
    );
  });

  it("binds the existing quantity and recalculated total into an amount-change preview", async () => {
    installReads({ ...CURRENT, quantity: 2, total: 250 });
    const preview = JSON.parse((await buildHandlers().update_expense_entry(UPDATE_ARGS)).content[0].text);
    expect(preview.proposal).toMatchObject({ amount: 150, quantity: 2, total: 300 });
  });

  it("rejects stale ETags, billed entries, and cross-matter allocation", async () => {
    installReads({ ...CURRENT, etag: '"new-etag"' });
    const stale = await buildHandlers().update_expense_entry(UPDATE_ARGS);
    expect(JSON.parse(stale.content[0].text).error).toMatch(/changed after it was retrieved/);
    installReads({ ...CURRENT, billed: true });
    const billed = await buildHandlers().update_expense_entry(UPDATE_ARGS);
    expect(JSON.parse(billed.content[0].text).error).toMatch(/Billed or invoiced/);
    installReads();
    const crossMatter = await buildHandlers().update_expense_entry({ ...UPDATE_ARGS, allocation_matter_id: 202 });
    expect(JSON.parse(crossMatter.content[0].text).error).toMatch(/Cross-matter allocation rejected/);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });
});
