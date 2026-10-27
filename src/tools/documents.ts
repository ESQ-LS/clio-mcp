import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import fs from "fs/promises";
import { constants, createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { clioGet, clioPost, clioPut, clioPatch, getClioBaseUrl, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import {
  consumeWritePreviewToken,
  makeWritePreviewToken,
  safeWriteError,
  writeJsonResult,
  writePreviewEnvelope,
} from "../esq/writePreview.js";
import { CLIO_CREATE_TOOL_ANNOTATIONS, CLIO_READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";

const DOCUMENT_LIST_FIELDS = "id,name,content_type,size,created_at,matter{id,display_number}";

const DOCUMENT_DETAIL_FIELDS =
  "id,name,content_type,size,created_at,matter{id,display_number},latest_document_version{uuid,created_at,size}";

const PART_SIZE = 10 * 1024 * 1024; // 10 MB — above S3's 5 MB minimum
const MAX_PARTS_PER_REQUEST = 50;
const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024 * 1024;

const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

async function partMd5(filePath: string, start: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const fh = await fs.open(filePath, "r");
  try {
    await fh.read(buf, 0, length, start);
  } finally {
    await fh.close();
  }
  return crypto.createHash("md5").update(buf).digest("base64");
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

type UploadSnapshot = {
  path: string;
  size: number;
  sha256: string;
  cleanup: () => Promise<void>;
};

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function verifyOpenedUploadPath(
  sourceHandle: Awaited<ReturnType<typeof fs.open>>,
  approvedRoot: string,
  approvedFile: string,
): Promise<void> {
  let openedPath: string;
  try {
    // Azure runs on Linux, where /proc resolves the path held by the open descriptor.
    openedPath = await fs.realpath(`/proc/self/fd/${sourceHandle.fd}`);
  } catch {
    // Portable fallback: re-resolve the pathname and bind it to the opened inode.
    openedPath = await fs.realpath(approvedFile);
  }
  if (!isPathWithin(approvedRoot, openedPath)) {
    throw new Error("The opened file is outside the approved upload root.");
  }
  const [openedStats, currentStats] = await Promise.all([
    sourceHandle.stat(),
    fs.stat(openedPath),
  ]);
  if (openedStats.dev !== currentStats.dev || openedStats.ino !== currentStats.ino) {
    throw new Error("The approved upload path changed while it was being opened.");
  }
}

async function createApprovedUploadSnapshot(filePath: string): Promise<UploadSnapshot> {
  const configuredRoot = process.env.ESQ_CLIO_UPLOAD_ROOT?.trim();
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error("Server configuration error: ESQ_CLIO_UPLOAD_ROOT must be an absolute path.");
  }
  if (!path.isAbsolute(filePath)) throw new Error("file_path must be absolute.");

  const inputStats = await fs.lstat(filePath);
  if (inputStats.isSymbolicLink()) throw new Error("Symbolic-link uploads are not permitted.");
  const [approvedRoot, approvedFile] = await Promise.all([
    fs.realpath(configuredRoot),
    fs.realpath(filePath),
  ]);
  if (!isPathWithin(approvedRoot, approvedFile)) {
    throw new Error("file_path is outside the approved upload root.");
  }
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "esq-clio-upload-"));
  const snapshotPath = path.join(snapshotDir, "payload");
  let sourceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    sourceHandle = await fs.open(approvedFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    await verifyOpenedUploadPath(sourceHandle, approvedRoot, approvedFile);
    const sourceStats = await sourceHandle.stat();
    if (!sourceStats.isFile()) throw new Error("file_path must identify a regular file.");
    if (sourceStats.size > MAX_DOCUMENT_SIZE) {
      throw new Error("file_path exceeds Clio's 5 GB document limit.");
    }
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }),
    );
    const snapshotStats = await fs.stat(snapshotPath);
    const sha256 = await fileSha256(snapshotPath);
    return {
      path: snapshotPath,
      size: snapshotStats.size,
      sha256,
      cleanup: () => fs.rm(snapshotDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(snapshotDir, { recursive: true, force: true });
    throw error;
  } finally {
    await sourceHandle?.close();
  }
}

async function putPartToS3(
  filePath: string,
  offset: number,
  length: number,
  putUrl: string,
  headers: Array<{ name: string; value: string }>
): Promise<void> {
  const buf = Buffer.alloc(length);
  const fh = await fs.open(filePath, "r");
  try {
    await fh.read(buf, 0, length, offset);
  } finally {
    await fh.close();
  }
  const hdrs: Record<string, string> = {};
  for (const h of headers) hdrs[h.name] = h.value;
  const res = await fetch(putUrl, { method: "PUT", headers: hdrs, body: buf });
  if (!res.ok) {
    throw new Error(`S3 upload failed for part at offset ${offset}: HTTP ${res.status}`);
  }
}

export function registerDocumentTools(server: McpServer): void {
  server.registerTool(
    "list_documents",
    {
      description: "List documents in Clio, filtered by matter or folder",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter documents by matter ID"),
        parent_id: z.number().int().positive().optional().describe("Filter documents by parent ID (folder)"),
        query: z.string().optional().describe("Full-text search string for document names"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_documents response to fetch the next page"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, parent_id, query, limit, page_token }) => {
      if (!matter_id && !parent_id && !query) {
        return {
          content: [{ type: "text", text: "Error: provide at least one of matter_id, parent_id, or query" }],
          isError: true,
        };
      }

      try {
        const params: Record<string, string> = { fields: DOCUMENT_LIST_FIELDS, limit: String(limit) };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (parent_id) params["parent_id"] = String(parent_id);
        if (query) params["query"] = query;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/documents.json", params);
        const docs = data.data as any[];
        const nextPageToken = docs.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_documents",
          args: { matter_id, parent_id, query, limit, page_token },
          outcome: "success",
          result_count: docs?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        if (!docs || docs.length === 0) {
          return { content: [{ type: "text", text: "No documents found." }] };
        }

        const result = {
          documents: docs.map((d) => ({
            id: d.id,
            name: d.name,
            content_type: d.content_type,
            size: d.size,
            created_at: d.created_at,
            matter: d.matter ? { id: d.matter.id, display_number: d.matter.display_number } : null,
          })),
          total_count: data.meta?.records ?? docs.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_documents",
          args: { matter_id, parent_id, query, limit, page_token },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_document",
    {
      description: "Get metadata and download URL for a single Clio document",
      inputSchema: {
        document_id: z.number().int().positive().describe("The Clio document ID"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ document_id }) => {
      try {
        const data = await clioGet(`/documents/${document_id}.json`, { fields: DOCUMENT_DETAIL_FIELDS });
        const doc = data.data;

        const versionUuid = doc.latest_document_version?.uuid ?? null;
        const download_url = versionUuid
          ? `${getClioBaseUrl()}/documents/${doc.id}/download?version_uuid=${versionUuid}`
          : null;

        const result = {
          id: doc.id,
          name: doc.name,
          content_type: doc.content_type,
          size: doc.size,
          created_at: doc.created_at,
          matter: doc.matter ? { id: doc.matter.id, display_number: doc.matter.display_number } : null,
          latest_version_uuid: versionUuid,
          download_url,
        };

        await appendAuditLog({ tool: "get_document", args: { document_id }, outcome: "success" });

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_document", args: { document_id }, outcome: "success" });
          return { content: [{ type: "text", text: `Document ${document_id} not found.` }] };
        }
        await appendAuditLog({ tool: "get_document", args: { document_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "upload_document",
    {
      title: "Upload a controlled document to a Clio matter",
      description: "Dry-run by default. Verifies the exact local file and target matter, then displays filename, size, type, and SHA-256. A production upload requires confirm_write: true plus the unexpired preview_token from an unchanged proposal.",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the local file to upload"),
        matter_id: z.number().int().positive().describe("Clio matter ID to attach the document to"),
        name: z.string().optional().describe("Document name in Clio; defaults to the file's basename"),
        content_type: z.string().optional().describe("MIME type; auto-detected from extension if omitted"),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ file_path, matter_id, name, content_type, confirm_write, preview_token }) => {
      let writeAttempted = false;
      let snapshot: UploadSnapshot | undefined;
      try {
        snapshot = await createApprovedUploadSnapshot(file_path);
        const totalSize = snapshot.size;
        const originalExt = path.extname(file_path);
        const docName = name
          ? (path.extname(name) ? name : name + originalExt)
          : path.basename(file_path);
        const mime = content_type ?? guessMime(docName);
        const sha256 = snapshot.sha256;
        const matterResponse = await clioGet(`/matters/${matter_id}.json`, {
          fields: "id,display_number,description,status",
        });
        if (matterResponse?.data?.id !== matter_id) throw new Error("Matter validation failed.");
        const proposal = {
          matter: {
            id: matter_id,
            display_number: matterResponse.data.display_number,
            description: matterResponse.data.description,
            status: matterResponse.data.status,
          },
          document: { name: docName, content_type: mime, size: totalSize, sha256 },
        };

        if (!confirm_write) {
          const auditOk = await appendAuditLog({
            tool: "upload_document", action: "create", confirmation_state: "dry_run",
            outcome: "success", matter_id,
            args: { confirm_write: false, matter_id, size: totalSize },
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "upload_document", proposal, await makeWritePreviewToken("upload_document", proposal),
          ));
        }

        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "upload_document", proposal);
        const preWriteAuditOk = await appendAuditLog({
          tool: "upload_document", action: "create", confirmation_state: "confirmed",
          outcome: "attempt", matter_id,
          args: { confirm_write: true, matter_id, size: totalSize },
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio upload was attempted.");
        writeAttempted = true;

        type PartDescriptor = { part_number: number; content_length: number; content_md5: string; offset: number };
        const allParts: PartDescriptor[] = [];
        let offset = 0;
        let partNumber = 1;
        while (offset < totalSize) {
          const length = Math.min(PART_SIZE, totalSize - offset);
          const md5 = await partMd5(snapshot.path, offset, length);
          allParts.push({ part_number: partNumber, content_length: length, content_md5: md5, offset });
          offset += length;
          partNumber++;
        }

        const firstBatch = allParts.slice(0, MAX_PARTS_PER_REQUEST);
        const createResp = await clioPost(
          "/documents.json?fields=id,latest_document_version{uuid,put_headers,multiparts}",
          {
            data: {
              name: docName,
              parent: { id: matter_id, type: "Matter" },
              content_type: mime,
              multiparts: firstBatch.map(({ part_number, content_length, content_md5 }) => ({
                part_number, content_length, content_md5,
              })),
            },
          }
        );

        const docId: number = createResp.data.id;
        const version = createResp.data.latest_document_version;
        const uuid: string = version.uuid;

        for (const multipart of version.multiparts as any[]) {
          const desc = firstBatch.find((p) => p.part_number === multipart.part_number)!;
          const partHeaders = multipart.put_headers ?? [];
          await putPartToS3(snapshot.path, desc.offset, desc.content_length, multipart.put_url, partHeaders);
        }

        let batchStart = MAX_PARTS_PER_REQUEST;
        while (batchStart < allParts.length) {
          const batch = allParts.slice(batchStart, batchStart + MAX_PARTS_PER_REQUEST);
          const batchResp = await clioPut(
            `/document_versions/${uuid}.json?fields=uuid,put_headers,multiparts`,
            {
              data: {
                uuid,
                fully_uploaded: false,
                multiparts: batch.map(({ part_number, content_length, content_md5 }) => ({
                  part_number, content_length, content_md5,
                })),
              },
            }
          );
          for (const multipart of batchResp.data.multiparts as any[]) {
            const desc = batch.find((p) => p.part_number === multipart.part_number)!;
            const partHeaders = multipart.put_headers ?? [];
            await putPartToS3(snapshot.path, desc.offset, desc.content_length, multipart.put_url, partHeaders);
          }
          batchStart += MAX_PARTS_PER_REQUEST;
        }

        await clioPatch(`/documents/${docId}.json?fields=id,latest_document_version{fully_uploaded}`, {
          data: { uuid, fully_uploaded: "true" },
        });

        await appendAuditLog({
          tool: "upload_document",
          action: "create",
          confirmation_state: "confirmed",
          args: { confirm_write: true, matter_id, size: totalSize },
          outcome: "success",
          matter_id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ document_id: docId, name: docName, uuid, parts: allParts.length }, null, 2),
          }],
        };
      } catch (err: any) {
        const message = safeWriteError(err);
        await appendAuditLog({
          tool: "upload_document",
          action: "create",
          confirmation_state: confirm_write ? "confirmed" : "dry_run",
          args: { confirm_write, matter_id },
          outcome: "error",
          error_message: message,
          matter_id,
        });
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Search the target Clio matter for the proposed document before retrying; the upload outcome may be ambiguous." }),
        }, true);
      } finally {
        try {
          await snapshot?.cleanup();
        } catch {
          console.error("[esq] Failed to remove a temporary Clio upload snapshot.");
        }
      }
    }
  );
}
