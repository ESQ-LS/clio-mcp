import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { mockClioGet, mockClioPost, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(), mockClioPost: vi.fn(), mockAppendAuditLog: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet, clioPost: mockClioPost };
});
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: vi.fn(async () => ({ clio_user_id: "100", expires_at: Date.now() + 60000 })),
}));

import { registerDocumentTools } from "../documents.js";

let tempDir = "";
beforeEach(async () => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
  mockClioGet.mockResolvedValue({ data: { id: 99, display_number: "00099-001", description: "Synthetic", status: "open" } });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clio-doc-test-"));
});
afterEach(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

describe("controlled document upload", () => {
  it("previews the exact file hash and target without starting an upload", async () => {
    const filePath = path.join(tempDir, "synthetic.txt");
    await fs.writeFile(filePath, "synthetic document\n");
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const result = await handlers.upload_document({ file_path: filePath, matter_id: 99 });
    const preview = JSON.parse(result.content[0].text);
    expect(preview.mode).toBe("dry_run");
    expect(preview.proposal.document).toMatchObject({ name: "synthetic.txt", content_type: "text/plain", size: 19 });
    expect(preview.proposal.document.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mockClioPost).not.toHaveBeenCalled();
    const audit = JSON.stringify(mockAppendAuditLog.mock.calls);
    expect(audit).not.toContain(filePath);
    expect(audit).not.toContain("synthetic.txt");
    expect(audit).not.toContain(preview.proposal.document.sha256);
  });
});
