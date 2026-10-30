import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { CLIO_CREATE_TOOL_ANNOTATIONS } from "./annotations.js";
import {
  consumeWritePreviewToken, makeWritePreviewToken, safeWriteError,
  writeJsonResult, writePreviewEnvelope,
} from "../esq/writePreview.js";

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    "create_note",
    {
      title: "Create a controlled matter note",
      description: "Dry-run by default. Displays the exact target matter, subject, and note body. A production write requires confirm_write: true plus the unexpired preview_token from an unchanged proposal.",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Matter ID to attach the note to"),
        subject: z.string().min(1).describe("Note subject / title"),
        body: z.string().min(1).describe("Note body text"),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, subject, body, confirm_write, preview_token }) => {
      let writeAttempted = false;
      try {
        const matter = (await clioGet(`/matters/${matter_id}.json`, {
          fields: "id,display_number,description,status",
        }))?.data;
        if (matter?.id !== matter_id) throw new Error("Matter validation failed.");
        const proposal = {
          matter: { id: matter.id, display_number: matter.display_number, description: matter.description, status: matter.status },
          note: { subject, body },
        };
        if (!confirm_write) {
          const auditOk = await appendAuditLog({
            tool: "create_note", action: "create", confirmation_state: "dry_run",
            args: { confirm_write: false, matter_id }, outcome: "success", matter_id,
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_note", proposal, await makeWritePreviewToken("create_note", proposal),
          ));
        }
        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "create_note", proposal);
        const preWriteAuditOk = await appendAuditLog({
          tool: "create_note", action: "create", confirmation_state: "confirmed",
          args: { confirm_write: true, matter_id }, outcome: "attempt", matter_id,
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const data = await clioPost("/notes.json", {
          data: {
            subject,
            detail: body,
            detail_text_type: "plain_text",
            type: "Matter",
            matter: { id: matter_id },
          },
        });
        const note = data.data;

        const auditOk = await appendAuditLog({
          tool: "create_note",
          action: "create", confirmation_state: "confirmed",
          args: { confirm_write: true, matter_id },
          outcome: "success",
          matter_id,
          record_id: note.id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              audit_recorded: auditOk,
              note: {
                id: note.id,
                subject: note.subject,
                matter_id,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const message = safeWriteError(err);
        await appendAuditLog({
          tool: "create_note",
          action: "create", confirmation_state: confirm_write ? "confirmed" : "dry_run",
          args: { confirm_write, matter_id },
          outcome: "error",
          error_message: message,
          matter_id,
        });
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Search the matter notes before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    }
  );
}
