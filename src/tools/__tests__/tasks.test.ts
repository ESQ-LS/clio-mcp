import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioGet, mockClioPost, mockClioPatch, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(), mockClioPost: vi.fn(), mockClioPatch: vi.fn(),
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

import { registerTaskTools } from "../tasks.js";

const TASK = {
  id: 1, etag: "task-v1", name: "Draft contract", description: "Synthetic task",
  priority: "Normal", status: "pending", due_at: "2026-01-15T00:00:00Z",
  matter: { id: 99, display_number: "00099-001", description: "Synthetic matter", status: "open" },
};
const handlers = new Map<string, (args: any) => Promise<any>>();

beforeAll(() => {
  registerTaskTools({
    registerTool: (name: string, _schema: unknown, handler: (args: any) => Promise<any>) => handlers.set(name, handler),
  } as any);
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
  mockClioGet.mockImplementation(async (path: string) => {
    if (path === "/tasks/1.json") return { data: TASK };
    if (path === "/matters/99.json") return { data: TASK.matter };
    if (path === "/users/42.json") return { data: { id: 42, name: "Synthetic Lawyer", enabled: true } };
    throw new Error(`unexpected path ${path}`);
  });
  mockClioPost.mockResolvedValue({ data: TASK });
  mockClioPatch.mockResolvedValue({ data: { ...TASK, status: "complete", completed_at: "2026-05-22T10:00:00Z" } });
});

describe("controlled task writes", () => {
  it("previews and confirms task creation with validated references", async () => {
    const args = { matter_id: 99, name: "Draft contract", description: "Synthetic task", priority: "Normal", due_date: "2026-01-15", assignee_id: 42 };
    const preview = JSON.parse((await handlers.get("create_task")!(args)).content[0].text);
    expect(preview.mode).toBe("dry_run");
    expect(mockClioPost).not.toHaveBeenCalled();
    await handlers.get("create_task")!({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/tasks.json", { data: {
      name: "Draft contract", description: "Synthetic task", priority: "Normal", due_at: "2026-01-15T00:00:00Z",
      matter: { id: 99 }, assignee: { id: 42, type: "User" },
    } });
    const audit = JSON.stringify(mockAppendAuditLog.mock.calls);
    expect(audit).not.toContain(args.name);
    expect(audit).not.toContain(args.description);
  });

  it("previews and conditionally updates a task", async () => {
    const args = { task_id: 1, status: "In Progress", due_date: "2026-01-16" };
    const preview = JSON.parse((await handlers.get("update_task")!(args)).content[0].text);
    expect(mockClioPatch).not.toHaveBeenCalled();
    await handlers.get("update_task")!({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/tasks/1.json", { data: {
      due_at: "2026-01-16T00:00:00Z", status: "in_progress",
    } }, { "If-Match": "task-v1" });
  });

  it("previews and conditionally completes a task", async () => {
    const preview = JSON.parse((await handlers.get("complete_task")!({ task_id: 1 })).content[0].text);
    expect(mockClioPatch).not.toHaveBeenCalled();
    const result = await handlers.get("complete_task")!({ task_id: 1, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/tasks/1.json", { data: { status: "complete" } }, { "If-Match": "task-v1" });
    expect(JSON.parse(result.content[0].text).task.status).toBe("complete");
  });

  it("refuses a stale task without writing", async () => {
    const args = { task_id: 1, name: "Updated" };
    const preview = JSON.parse((await handlers.get("update_task")!(args)).content[0].text);
    mockClioGet.mockResolvedValue({ data: { ...TASK, etag: "task-v2" } });
    const result = await handlers.get("update_task")!({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("requires at least one field for updates", async () => {
    const result = await handlers.get("update_task")!({ task_id: 1 });
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });
});
