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
import { clioGet, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { CLIO_READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";

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
}
