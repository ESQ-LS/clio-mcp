import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { appendFileSync, constants, createReadStream } from "fs";

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

import { readExactBytes, registerDocumentTools } from "../documents.js";

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
  it("fills buffers across short reads and fails on premature EOF", async () => {
    const source = Buffer.from("synthetic bytes");
    const shortReader = {
      read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(2, length, source.length - position);
        if (bytesRead > 0) source.copy(target, offset, position, position + bytesRead);
        return { bytesRead, buffer: target };
      }),
    };
    await expect(readExactBytes(shortReader as any, 0, source.length)).resolves.toEqual(source);
    await expect(readExactBytes(shortReader as any, 0, source.length + 1))
      .rejects.toThrow("Unexpected end of upload snapshot");
  });

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

  it("rejects empty files before preview authorization", async () => {
    const filePath = path.join(tempDir, "empty.txt");
    await fs.writeFile(filePath, "");
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const result = await handlers.upload_document({ file_path: filePath, matter_id: 99 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Empty files cannot be uploaded to Clio");
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("opens the approved source with no-follow semantics", async () => {
    const filePath = path.join(tempDir, "synthetic.txt");
    await fs.writeFile(filePath, "synthetic document\n");
    const openSpy = vi.spyOn(fs, "open");
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    await handlers.upload_document({ file_path: filePath, matter_id: 99 });
    const realFilePath = await fs.realpath(filePath);
    const sourceOpen = openSpy.mock.calls.find(([candidate, flags]) =>
      candidate === realFilePath && typeof flags === "number");
    expect(sourceOpen).toBeDefined();
    expect((sourceOpen![1] as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    openSpy.mockRestore();
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

  it("rejects an opened descriptor that resolves outside the approved root", async () => {
    const filePath = path.join(tempDir, "synthetic.txt");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "clio-doc-swapped-"));
    const outsidePath = path.join(outsideDir, "outside.txt");
    await fs.writeFile(filePath, "approved");
    await fs.writeFile(outsidePath, "outside");
    const originalRealpath = fs.realpath.bind(fs);
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
      if (String(candidate).startsWith("/proc/self/fd/")) return outsidePath;
      return originalRealpath(candidate);
    });
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const result = await handlers.upload_document({ file_path: filePath, matter_id: 99 });
    expect(JSON.parse(result.content[0].text).error).toContain("opened file is outside the approved upload root");
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
    realpathSpy.mockRestore();
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("rejects files above Clio's limit before copying or hashing them", async () => {
    const filePath = path.join(tempDir, "oversized.bin");
    await fs.writeFile(filePath, "");
    await fs.truncate(filePath, 5 * 1024 * 1024 * 1024 + 1);
    const openSpy = vi.spyOn(fs, "open");
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const result = await handlers.upload_document({ file_path: filePath, matter_id: 99 });
    expect(JSON.parse(result.content[0].text).error).toContain("5 GB document limit");
    expect(openSpy.mock.results.filter(({ value }) => value && typeof value === "object")).toHaveLength(1);
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("bounds the snapshot stream to the validated size", async () => {
    const filePath = path.join(tempDir, "growing.txt");
    const original = "approved bytes";
    await fs.writeFile(filePath, original);
    const realFilePath = await fs.realpath(filePath);
    const originalOpen = fs.open.bind(fs);
    let streamOptions: any;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === realFilePath && typeof args[1] === "number") {
        const originalCreateReadStream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, "createReadStream").mockImplementation((options: any) => {
          streamOptions = options;
          appendFileSync(filePath, " appended after validation");
          return originalCreateReadStream(options);
        });
      }
      return handle;
    });
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const preview = JSON.parse((await handlers.upload_document({ file_path: filePath, matter_id: 99 })).content[0].text);
    expect(streamOptions).toMatchObject({ start: 0, end: Buffer.byteLength(original) - 1 });
    expect(preview.proposal.document.size).toBe(Buffer.byteLength(original));
    openSpy.mockRestore();
  });

  it("rejects a snapshot whose final size differs from the validated file", async () => {
    const filePath = path.join(tempDir, "changing.txt");
    const shortPath = path.join(tempDir, "short.txt");
    await fs.writeFile(filePath, "approved bytes");
    await fs.writeFile(shortPath, "short");
    const realFilePath = await fs.realpath(filePath);
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === realFilePath && typeof args[1] === "number") {
        vi.spyOn(handle, "createReadStream").mockImplementation(() => createReadStream(shortPath));
      }
      return handle;
    });
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const result = await handlers.upload_document({ file_path: filePath, matter_id: 99 });
    expect(JSON.parse(result.content[0].text).error).toContain("changed while its snapshot was being created");
    expect(mockClioGet).not.toHaveBeenCalled();
    openSpy.mockRestore();
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
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/documents/7.json?fields=id,latest_document_version{fully_uploaded}",
      { data: { uuid: "synthetic-version", fully_uploaded: true } },
    );
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "upload_document", outcome: "success", record_id: 7,
    }));
    vi.unstubAllGlobals();
  });

  it("reports a failed final audit after a successful document upload", async () => {
    const filePath = path.join(tempDir, "synthetic.txt");
    await fs.writeFile(filePath, "approved bytes");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    mockClioPost.mockResolvedValue({ data: { id: 7, latest_document_version: {
      uuid: "synthetic-version", multiparts: [{ part_number: 1, put_url: "https://upload.test", put_headers: [] }],
    } } });
    mockClioPatch.mockResolvedValue({ data: { id: 7 } });
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const args = { file_path: filePath, matter_id: 99 };
    const preview = JSON.parse((await handlers.upload_document(args)).content[0].text);
    mockAppendAuditLog.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await handlers.upload_document({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ document_id: 7, audit_recorded: false });
    vi.unstubAllGlobals();
  });

  it("does not replace a successful upload result when snapshot cleanup fails", async () => {
    const filePath = path.join(tempDir, "synthetic.txt");
    await fs.writeFile(filePath, "approved bytes");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    mockClioPost.mockResolvedValue({ data: { id: 7, latest_document_version: {
      uuid: "synthetic-version", multiparts: [{ part_number: 1, put_url: "https://upload.test", put_headers: [] }],
    } } });
    mockClioPatch.mockResolvedValue({ data: { id: 7 } });
    const handlers: Record<string, Function> = {};
    registerDocumentTools({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } } as any);
    const args = { file_path: filePath, matter_id: 99 };
    const preview = JSON.parse((await handlers.upload_document(args)).content[0].text);
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementationOnce(async (...rmArgs) => {
      await originalRm(...rmArgs);
      throw new Error("synthetic cleanup failure");
    }).mockImplementation(originalRm);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await handlers.upload_document({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ document_id: 7, uuid: "synthetic-version" });
    expect(errorSpy).toHaveBeenCalledWith("[esq] Failed to remove a temporary Clio upload snapshot.");
    rmSpy.mockRestore();
    errorSpy.mockRestore();
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
