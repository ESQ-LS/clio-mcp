import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LOCAL_READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";
import { appendAuditLog, readAuditLog } from "../utils/auditLog.js";

export function registerAuditExportTool(server: McpServer): void {
  server.registerTool(
    "export_audit_log",
    {
      description:
        "Export audit log entries for bar review and ABA Opinion 512 compliance. Supports filtering by date range and matter. Results are paginated (default 500 per page).",
      inputSchema: {
        date_from: z.string().date().optional()
          .describe("Start date inclusive (YYYY-MM-DD), compared against entry timestamp."),
        date_to: z.string().date().optional()
          .describe("End date inclusive (YYYY-MM-DD), compared against entry timestamp."),
        matter_id: z.number().int().positive().optional()
          .describe("Return only entries associated with this Clio matter ID."),
        limit: z.number().int().min(1).max(1000).default(500)
          .describe("Maximum entries to return (1–1000)."),
        offset: z.number().int().min(0).default(0)
          .describe("Zero-based offset for pagination."),
      },
      annotations: LOCAL_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ date_from, date_to, matter_id, limit, offset }) => {
      try {
        const result = await readAuditLog({ date_from, date_to, matter_id, limit, offset });

        await appendAuditLog({
          tool: "export_audit_log",
          args: { date_from, date_to, matter_id, limit, offset },
          outcome: "success",
          result_count: result.entries.length,
          ...(matter_id !== undefined && { matter_id }),
        });

        const summary: Record<string, unknown> = {
          total_matched: result.total_matched,
          returned: result.entries.length,
          offset,
          truncated: result.truncated,
        };
        if (result.truncated) {
          summary.next_offset = offset + result.entries.length;
          summary.note = "Results truncated. Call again with next_offset to retrieve more entries.";
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, entries: result.entries }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "export_audit_log",
          args: { date_from, date_to, matter_id, limit, offset },
          outcome: "error",
          error_message: err.message,
        });
        return {
          content: [{ type: "text" as const, text: `Failed to export audit log: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
