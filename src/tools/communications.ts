/**
 * ESQ fork: ported from the retired Python Clio MCP server
 * (clio_list_communications). No upstream equivalent.
 *
 * Read-only. Clio's /communications.json returns logged calls, emails and
 * secure messages. Body text is truncated in the response to keep matter
 * correspondence out of the transcript unless specifically requested.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { CLIO_CREATE_TOOL_ANNOTATIONS, CLIO_READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";
import {
  consumeWritePreviewToken, makeWritePreviewToken, safeWriteError,
  writeJsonResult, writePreviewEnvelope,
} from "../esq/writePreview.js";

const COMMUNICATION_FIELDS =
  "id,subject,body,type,date,senders{name},receivers{name},matter{id,display_number}";

const BODY_PREVIEW_CHARS = 500;

export function registerCommunicationTools(server: McpServer): void {
  server.registerTool(
    "list_communications",
    {
      description:
        "List logged communications (calls, emails, secure messages) on a matter or across matters. Body text is truncated to a preview; use full_body to retrieve complete message text.",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter communications by matter ID"),
        query: z.string().optional().describe("Full-text search string"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z
          .string()
          .optional()
          .describe("Cursor from a previous list_communications response to fetch the next page"),
        full_body: z
          .boolean()
          .default(false)
          .describe("Return complete message bodies instead of truncated previews"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, query, limit, page_token, full_body }) => {
      const auditArgs = { matter_id, query, limit, page_token, full_body };
      try {
        const params: Record<string, string> = {
          fields: COMMUNICATION_FIELDS,
          limit: String(limit),
        };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (query) params["query"] = query;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/communications.json", params);
        const comms = (data.data ?? []) as any[];
        const nextPageToken = comms.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_communications",
          args: auditArgs,
          outcome: "success",
          result_count: comms.length,
          ...(matter_id && { matter_id }),
        });

        if (comms.length === 0) {
          return { content: [{ type: "text", text: "No communications found." }] };
        }

        const result = {
          communications: comms.map((c) => {
            const body: string = c.body ?? "";
            const truncated = !full_body && body.length > BODY_PREVIEW_CHARS;
            return {
              id: c.id,
              type: c.type,
              subject: c.subject,
              date: c.date,
              senders: (c.senders ?? []).map((s: any) => s.name),
              receivers: (c.receivers ?? []).map((r: any) => r.name),
              matter: c.matter ? { id: c.matter.id, display_number: c.matter.display_number } : null,
              body: truncated ? body.slice(0, BODY_PREVIEW_CHARS) : body,
              body_truncated: truncated,
            };
          }),
          total_count: data.meta?.records ?? comms.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_communications",
          args: auditArgs,
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  const participantSchema = z.object({
    id: z.number().int().positive(),
    type: z.enum(["User", "Contact"]),
  });
  server.registerTool(
    "create_communication",
    {
      title: "Log a controlled Clio communication",
      description: "Dry-run by default. Validates the target matter and every sender and receiver, then displays the complete communication. This records a log only; it does not send email. A production write requires confirm_write: true plus an unchanged preview_token.",
      inputSchema: {
        matter_id: z.number().int().positive(),
        type: z.enum(["PhoneCommunication", "EmailCommunication"]),
        subject: z.string().trim().min(1).max(1000),
        body: z.string().min(1),
        received_at: z.string().datetime({ offset: true }),
        senders: z.array(participantSchema).min(1).max(20),
        receivers: z.array(participantSchema).min(1).max(20),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, type, subject, body, received_at, senders, receivers, confirm_write, preview_token }) => {
      let writeAttempted = false;
      try {
        const matter = (await clioGet(`/matters/${matter_id}.json`, { fields: "id,display_number,description,status" }))?.data;
        if (matter?.id !== matter_id) throw new Error("Matter validation failed.");
        const validatedParticipants = [];
        const participantCache = new Map<string, { id: number; name: string }>();
        for (const participant of [...senders, ...receivers]) {
          const endpoint = participant.type === "User" ? "users" : "contacts";
          const cacheKey = `${participant.type}:${participant.id}`;
          let record = participantCache.get(cacheKey);
          if (!record) {
            record = (await clioGet(`/${endpoint}/${participant.id}.json`, { fields: "id,name" }))?.data;
            if (record?.id === participant.id) participantCache.set(cacheKey, record);
          }
          if (record?.id !== participant.id) throw new Error(`${participant.type} ${participant.id} validation failed.`);
          validatedParticipants.push({ ...participant, name: record.name });
        }
        const data = { matter: { id: matter_id }, type, subject, body, received_at, senders, receivers };
        const proposal = {
          matter: { id: matter.id, display_number: matter.display_number, description: matter.description, status: matter.status },
          communication: data,
          validated_participants: validatedParticipants,
          sends_external_message: false,
        };
        if (!confirm_write) {
          const auditOk = await appendAuditLog({
            tool: "create_communication", action: "create", confirmation_state: "dry_run",
            args: { confirm_write: false, matter_id, type, received_at, participant_count: senders.length + receivers.length },
            outcome: "success", matter_id,
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_communication", proposal,
            await makeWritePreviewToken("create_communication", proposal),
          ));
        }
        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "create_communication", proposal);
        const preWriteAuditOk = await appendAuditLog({
          tool: "create_communication", action: "create", confirmation_state: "confirmed",
          args: { confirm_write: true, matter_id, type, received_at, participant_count: senders.length + receivers.length },
          outcome: "attempt", matter_id,
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const response = await clioPost("/communications.json", { data });
        if (!response?.data?.id) throw new Error("Clio returned an invalid create response.");
        const auditOk = await appendAuditLog({
          tool: "create_communication", action: "create", confirmation_state: "confirmed",
          args: { confirm_write: true, matter_id, type, received_at }, outcome: "success", matter_id,
          record_id: response.data.id,
        });
        return writeJsonResult({ mode: "confirmed_write", write_performed: true, action: "create_communication", record_id: response.data.id, audit_recorded: auditOk, communication: response.data });
      } catch (error) {
        const message = safeWriteError(error);
        await appendAuditLog({
          tool: "create_communication", action: "create", confirmation_state: confirm_write ? "confirmed" : "dry_run",
          args: { confirm_write, matter_id, type, received_at }, outcome: "error", error_message: message, matter_id,
        });
        return writeJsonResult({ error: message, write_performed: writeAttempted ? "unknown" : false }, true);
      }
    },
  );
}
