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
  notify_completion: false, assigner: { id: 7, name: "Synthetic Assigner" },
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
    expect(preview.proposal.task.permission).toBe("public");
    expect(mockClioPost).not.toHaveBeenCalled();
    await handlers.get("create_task")!({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/tasks.json", { data: {
      name: "Draft contract", description: "Synthetic task", priority: "Normal", due_at: "2026-01-15T00:00:00Z",
      matter: { id: 99 }, assignee: { id: 42, type: "User" }, permission: "public",
    } });
    const audit = JSON.stringify(mockAppendAuditLog.mock.calls);
    expect(audit).not.toContain(args.name);
    expect(audit).not.toContain(args.description);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_task", outcome: "success", record_id: 1,
    }));
  });

  it("previews and conditionally updates a task", async () => {
    const args = { task_id: 1, status: "Complete", due_date: "2026-01-16" };
    const preview = JSON.parse((await handlers.get("update_task")!(args)).content[0].text);
    expect(mockClioPatch).not.toHaveBeenCalled();
    await handlers.get("update_task")!({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/tasks/1.json", { data: {
      due_at: "2026-01-16T00:00:00Z", status: "complete",
    } }, { "If-Match": "task-v1" });
  });

  it.each(["In Progress", "In Review", "Draft"])(
    "rejects the advanced %s status before issuing a preview",
    async (status) => {
      const result = await handlers.get("update_task")!({ task_id: 1, status });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("account entitlement cannot be verified");
      expect(mockClioPatch).not.toHaveBeenCalled();
    },
  );

  it("discloses every firm user removed by singular assignee replacement", async () => {
    mockClioGet.mockImplementation(async (path: string, params?: Record<string, string>) => {
      if (path === "/tasks/1.json") {
        expect(params?.fields).toContain("assignees{id,name}");
        return { data: {
          ...TASK,
          assignee: { id: 41, name: "Synthetic Primary" },
          assignees: [
            { id: 41, name: "Synthetic Primary" },
            { id: 42, name: "Synthetic Lawyer" },
            { id: 43, name: "Synthetic Reviewer" },
          ],
        } };
      }
      if (path === "/users/42.json") return { data: { id: 42, name: "Synthetic Lawyer", enabled: true } };
      throw new Error(`unexpected path ${path}`);
    });
    const preview = JSON.parse((await handlers.get("update_task")!({ task_id: 1, assignee_id: 42 })).content[0].text);
    expect(preview.proposal.current.assignees).toHaveLength(3);
    expect(preview.proposal.assignee_replacement).toEqual({
      warning: "Replacing the singular assignee will remove the other firm-user assignees.",
      removed_assignees: [
        { id: 41, name: "Synthetic Primary" },
        { id: 43, name: "Synthetic Reviewer" },
      ],
    });
  });

  it("rejects impossible task dates before preview authorization", async () => {
    const created = await handlers.get("create_task")!({
      matter_id: 99, name: "Draft contract", description: "Synthetic task",
      priority: "Normal", due_date: "2026-02-31",
    });
    const updated = await handlers.get("update_task")!({ task_id: 1, due_date: "2026-13-01" });
    expect(created.isError).toBe(true);
    expect(updated.isError).toBe(true);
    expect(mockClioPost).not.toHaveBeenCalled();
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("previews and conditionally completes a task", async () => {
    const preview = JSON.parse((await handlers.get("complete_task")!({ task_id: 1 })).content[0].text);
    expect(preview.proposal.completion_notification).toEqual({ will_send: false, recipient: null });
    expect(mockClioPatch).not.toHaveBeenCalled();
    const result = await handlers.get("complete_task")!({ task_id: 1, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPatch).toHaveBeenCalledWith("/tasks/1.json", { data: { status: "complete" } }, { "If-Match": "task-v1" });
    expect(JSON.parse(result.content[0].text).task.status).toBe("complete");
  });

  it("discloses the completion notification and recipient for both completion paths", async () => {
    mockClioGet.mockImplementation(async (requestPath: string, params?: Record<string, string>) => {
      if (requestPath === "/tasks/1.json") {
        expect(params?.fields).toContain("notify_completion");
        expect(params?.fields).toContain("assigner{id,name}");
        return { data: { ...TASK, notify_completion: true } };
      }
      throw new Error(`unexpected path ${requestPath}`);
    });
    const expected = {
      will_send: true,
      recipient: { id: 7, name: "Synthetic Assigner" },
    };
    const completePreview = JSON.parse((await handlers.get("complete_task")!({ task_id: 1 })).content[0].text);
    expect(completePreview.proposal.completion_notification).toEqual(expected);
    const updatePreview = JSON.parse((await handlers.get("update_task")!({ task_id: 1, status: "Complete" })).content[0].text);
    expect(updatePreview.proposal.completion_notification).toEqual(expected);
  });

  it("refuses completion when an enabled notification recipient cannot be validated", async () => {
    mockClioGet.mockResolvedValue({ data: { ...TASK, notify_completion: true, assigner: null } });
    const result = await handlers.get("complete_task")!({ task_id: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("notification recipient could not be validated");
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("reports failed final audits after successful create, update, and complete writes", async () => {
    const cases = [
      { tool: "create_task", args: { matter_id: 99, name: "Draft contract", description: "Synthetic task", priority: "Normal" } },
      { tool: "update_task", args: { task_id: 1, name: "Updated task" } },
      { tool: "complete_task", args: { task_id: 1 } },
    ];
    for (const testCase of cases) {
      mockAppendAuditLog.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const handler = handlers.get(testCase.tool)!;
      const preview = JSON.parse((await handler(testCase.args)).content[0].text);
      const result = await handler({ ...testCase.args, confirm_write: true, preview_token: preview.preview_token });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ success: true, audit_recorded: false });
    }
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
