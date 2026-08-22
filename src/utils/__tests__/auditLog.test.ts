import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockReadFile, mockAppendFile, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockAppendFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: mockReadFile,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
  },
}));

vi.mock("os", () => ({
  default: {
    homedir: () => "/tmp/test-home",
    networkInterfaces: () => ({
      eth0: [{ family: "IPv4", internal: false, address: "10.0.0.1" }],
    }),
  },
}));

vi.mock("../tokenStorage.js", () => ({
  loadTokens: vi.fn().mockResolvedValue(null),
}));

import { appendAuditLog, readAuditLog } from "../auditLog.js";

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2024-06-15T12:00:00.000Z",
    session_id: "sess-1",
    tool: "list_matters",
    args: {},
    outcome: "success",
    ...overrides,
  };
}

function toJSONL(...entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

describe("appendAuditLog", () => {
  it("redacts billing narratives and supporting evidence", async () => {
    const persisted = await appendAuditLog({
      tool: "create_time_entry",
      action: "create",
      confirmation_state: "dry_run",
      outcome: "success",
      matter_id: 101,
      args: {
        narrative: "Confidential synthetic narrative",
        supporting_evidence: "Confidential synthetic evidence",
        confirm_write: false,
      },
    });
    expect(persisted).toBe(true);
    const written = mockAppendFile.mock.calls[0][1] as string;
    expect(written).not.toContain("Confidential synthetic narrative");
    expect(written).not.toContain("Confidential synthetic evidence");
    expect(written).toContain('"narrative":"[REDACTED]"');
    expect(written).toContain('"supporting_evidence":"[REDACTED]"');
  });

  it("reports persistence failure to confirmation-gated callers", async () => {
    mockAppendFile.mockRejectedValueOnce(new Error("synthetic disk failure"));
    const persisted = await appendAuditLog({ tool: "create_time_entry", args: {}, outcome: "error" });
    expect(persisted).toBe(false);
  });
});

describe("readAuditLog", () => {
  it("returns empty result when audit file does not exist", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await readAuditLog();
    expect(result).toEqual({ entries: [], total_matched: 0, truncated: false });
  });

  it("returns empty result for empty file", async () => {
    mockReadFile.mockResolvedValue("");
    const result = await readAuditLog();
    expect(result).toEqual({ entries: [], total_matched: 0, truncated: false });
  });

  it("returns all entries when no filter is applied", async () => {
    mockReadFile.mockResolvedValue(toJSONL(makeEntry(), makeEntry(), makeEntry()));
    const result = await readAuditLog();
    expect(result.entries).toHaveLength(3);
    expect(result.total_matched).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("filters by date_from (inclusive)", async () => {
    mockReadFile.mockResolvedValue(toJSONL(
      makeEntry({ timestamp: "2024-01-01T00:00:00.000Z" }),
      makeEntry({ timestamp: "2024-06-15T00:00:00.000Z" }),
      makeEntry({ timestamp: "2025-01-01T00:00:00.000Z" }),
    ));
    const result = await readAuditLog({ date_from: "2024-06-01" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].timestamp).toContain("2024-06-15");
    expect(result.total_matched).toBe(2);
  });

  it("filters by date_to (inclusive)", async () => {
    mockReadFile.mockResolvedValue(toJSONL(
      makeEntry({ timestamp: "2024-01-01T00:00:00.000Z" }),
      makeEntry({ timestamp: "2024-06-15T00:00:00.000Z" }),
      makeEntry({ timestamp: "2025-01-01T00:00:00.000Z" }),
    ));
    const result = await readAuditLog({ date_to: "2024-12-31" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1].timestamp).toContain("2024-06-15");
    expect(result.total_matched).toBe(2);
  });

  it("filters by matter_id (exact match)", async () => {
    mockReadFile.mockResolvedValue(toJSONL(
      makeEntry({ matter_id: 1 }),
      makeEntry({ matter_id: 2 }),
      makeEntry({ matter_id: 1 }),
    ));
    const result = await readAuditLog({ matter_id: 1 });
    expect(result.entries).toHaveLength(2);
    expect(result.total_matched).toBe(2);
  });

  it("paginates with limit", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ tool: `tool_${i}` }));
    mockReadFile.mockResolvedValue(toJSONL(...entries));
    const result = await readAuditLog({ limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.total_matched).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("paginates with offset", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ tool: `tool_${i}` }));
    mockReadFile.mockResolvedValue(toJSONL(...entries));
    const result = await readAuditLog({ limit: 2, offset: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].tool).toBe("tool_2");
    expect(result.total_matched).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("does not set truncated on the last page", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ tool: `tool_${i}` }));
    mockReadFile.mockResolvedValue(toJSONL(...entries));
    const result = await readAuditLog({ limit: 2, offset: 4 });
    expect(result.entries).toHaveLength(1);
    expect(result.total_matched).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("skips malformed JSON lines silently", async () => {
    const good = makeEntry();
    const jsonl = [JSON.stringify(good), "not valid json {{", JSON.stringify(good)].join("\n");
    mockReadFile.mockResolvedValue(jsonl);
    const result = await readAuditLog();
    expect(result.entries).toHaveLength(2);
  });

  it("includes old entries that are missing session_id without error", async () => {
    const oldEntry = { timestamp: "2024-01-01T00:00:00.000Z", tool: "list_matters", args: {}, outcome: "success" };
    mockReadFile.mockResolvedValue(JSON.stringify(oldEntry));
    const result = await readAuditLog();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].tool).toBe("list_matters");
  });
});
