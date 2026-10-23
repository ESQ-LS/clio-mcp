import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { mockClioGet, mockClioPost, mockClioPut, mockClioPatch, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(), mockClioPost: vi.fn(), mockClioPut: vi.fn(), mockClioPatch: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet, clioPost: mockClioPost, clioPut: mockClioPut, clioPatch: mockClioPatch };
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
  process.env.ESQ_CLIO_UPLOAD_ROOT = tempDir;
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

  it("rejects files outside the approved root and symbolic links", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "clio-doc-outside-"));
    const outsidePath = path.join(outsideDir, "private.txt");
    const linkPath = path.join(tempDir, "linked.txt");
    await fs.writeFile(outsidePath, "private");
    await fs.symlink(outsidePath, linkPath);
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);

    const outside = await handlers.upload_document({ file_path: outsidePath, matter_id: 99 });
    const linked = await handlers.upload_document({ file_path: linkPath, matter_id: 99 });
    expect(JSON.parse(outside.content[0].text).error).toContain("approved upload root");
    expect(JSON.parse(linked.content[0].text).error).toContain("Symbolic-link");
    expect(mockClioPost).not.toHaveBeenCalled();
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("uploads the immutable snapshot that matched the preview", async () => {
    const filePath = path.join(tempDir, "synthetic.txt");
    await fs.writeFile(filePath, "approved bytes");
    const uploaded: Buffer[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: any) => {
      uploaded.push(Buffer.from(init.body));
      return { ok: true };
    }));
    mockClioPost.mockImplementation(async () => {
      await fs.writeFile(filePath, "changed after snapshot");
      return { data: { id: 7, latest_document_version: {
        uuid: "synthetic-version", multiparts: [{ part_number: 1, put_url: "https://upload.test", put_headers: [] }],
      } } };
    });
    mockClioPatch.mockResolvedValue({ data: { id: 7 } });
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const args = { file_path: filePath, matter_id: 99 };
    const preview = JSON.parse((await handlers.upload_document(args)).content[0].text);
    await fs.writeFile(filePath, "approved bytes");
    const confirmed = await handlers.upload_document({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(confirmed.isError).not.toBe(true);
    expect(Buffer.concat(uploaded).toString()).toBe("approved bytes");
    vi.unstubAllGlobals();
  });

  it("does not expose a missing local path in errors or audits", async () => {
    const missing = path.join(tempDir, "client-secret-name.txt");
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const result = await handlers.upload_document({ file_path: missing, matter_id: 99 });
    expect(result.content[0].text).toContain("Local file operation failed");
    expect(result.content[0].text).not.toContain(missing);
    expect(JSON.stringify(mockAppendAuditLog.mock.calls)).not.toContain(missing);
  });
});
