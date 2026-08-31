import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { CLIO_READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";

const BILL_FIELDS = "id,number,issued_at,due_at,balance,total,state";

// ESQ fork: ported from the retired Python Clio MCP server.
const BILL_LIST_FIELDS =
  "id,number,issued_at,due_at,state,balance,total,client{id,name},matters{display_number}";

export function registerBillingTools(server: McpServer): void {
  server.registerTool(
    "get_billing_summary",
    {
      description: "Get a billing summary for a matter — total billed, outstanding balance, and last invoice date",
      inputSchema: {
        matter_id: z.number().int().positive().describe("The Clio matter ID"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ matter_id }) => {
      try {
        const data = await clioGet("/bills.json", {
          matter_id: String(matter_id),
          fields: BILL_FIELDS,
          limit: "200",
        });
        const bills = data.data as any[];

        const activeBills = bills.filter((b) => b.state !== "draft" && b.state !== "void");
        const total_billed = activeBills.reduce((s: number, b: any) => s + (b.total ?? 0), 0);
        const total_outstanding = activeBills.reduce((s: number, b: any) => s + (b.balance ?? 0), 0);
        const last_invoice_date =
          activeBills
            .map((b: any) => b.issued_at)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null;

        const result = {
          matter_id,
          bill_count: activeBills.length,
          total_billed,
          total_outstanding,
          last_invoice_date,
        };

        await appendAuditLog({ tool: "get_billing_summary", args: { matter_id }, outcome: "success", matter_id });

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "get_billing_summary", args: { matter_id }, outcome: "error", error_message: err.message, matter_id });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ESQ fork: ported from the retired Python Clio MCP server (clio_list_bills).
  server.registerTool(
    "list_bills",
    {
      description:
        "List bills (invoices), optionally filtered by matter or state. Returns individual invoices with number, dates, state and balance — use get_billing_summary for matter-level totals.",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter bills by matter ID"),
        state: z
          .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void", "deleted"])
          .optional()
          .describe("Filter by bill state"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_bills response to fetch the next page"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, state, limit, page_token }) => {
      const auditArgs = { matter_id, state, limit, page_token };
      try {
        const params: Record<string, string> = { fields: BILL_LIST_FIELDS, limit: String(limit) };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (state) params["state"] = state;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/bills.json", params);
        const bills = (data.data ?? []) as any[];
        const nextPageToken = bills.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_bills",
          args: auditArgs,
          outcome: "success",
          result_count: bills.length,
          ...(matter_id && { matter_id }),
        });

        if (bills.length === 0) {
          return { content: [{ type: "text", text: "No bills found." }] };
        }

        const result = {
          bills: bills.map((b) => ({
            id: b.id,
            number: b.number,
            state: b.state,
            issued_at: b.issued_at,
            due_at: b.due_at,
            total: b.total,
            balance: b.balance,
            client: b.client ? { id: b.client.id, name: b.client.name } : null,
            matters: (b.matters ?? []).map((m: any) => m.display_number),
          })),
          total_count: data.meta?.records ?? bills.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_bills",
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
