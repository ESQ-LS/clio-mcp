import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { CLIO_CREATE_TOOL_ANNOTATIONS, CLIO_READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";

const CALENDAR_FIELDS = "id,summary,description,start_at,end_at,matter{id,display_number},attendees{id,name}";

export function toIso(input: string, endOfDay = false): string {
  if (!/T/.test(input)) {
    return endOfDay ? `${input}T23:59:59` : `${input}T00:00:00`;
  }
  return input.length === 16 ? `${input}:00` : input;
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    "list_calendar_entries",
    {
      description: "List calendar entries in Clio for a given date range",
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("ISO date (YYYY-MM-DD) — range start, inclusive"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("ISO date (YYYY-MM-DD) — range end, inclusive"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ from, to }) => {
      try {
        const data = await clioGet("/calendar_entries.json", {
          from: `${from}T00:00:00Z`,
          to: `${to}T23:59:59Z`,
          fields: CALENDAR_FIELDS,
        });
        const entries = data.data as any[];

        await appendAuditLog({ tool: "list_calendar_entries", args: { from, to }, outcome: "success", result_count: entries?.length ?? 0 });

        if (!entries || entries.length === 0) {
          return { content: [{ type: "text", text: "No calendar entries found." }] };
        }

        const result = entries.map((e) => ({
          id: e.id,
          summary: e.summary,
          description: e.description ?? null,
          start_at: e.start_at,
          end_at: e.end_at,
          matter: e.matter ? { id: e.matter.id, display_number: e.matter.display_number } : null,
          attendees: (e.attendees ?? []).map((a: any) => ({ id: a.id, name: a.name })),
        }));

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "list_calendar_entries", args: { from, to }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "list_calendars",
    {
      description: "List calendars available in Clio — use the returned id as calendar_owner_id when creating entries",
      inputSchema: {},
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      try {
        const data = await clioGet("/calendars.json", { writeable: "true", fields: "id,name,type,color" });
        const calendars = data.data as any[];

        await appendAuditLog({ tool: "list_calendars", args: {}, outcome: "success", result_count: calendars?.length ?? 0 });

        if (!calendars || calendars.length === 0) {
          return { content: [{ type: "text", text: "No calendars found." }] };
        }

        const result = calendars.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type ?? null,
          color: c.color ?? null,
        }));

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "list_calendars", args: {}, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_calendar_entry",
    {
      description: "Create a calendar entry (hearing, deadline, meeting) in Clio",
      inputSchema: {
        summary: z.string().min(1).describe("Short title of the event"),
        start_at: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).describe("Date or datetime in local time — YYYY-MM-DD, YYYY-MM-DDTHH:MM, or YYYY-MM-DDTHH:MM:SS"),
        end_at: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).describe("Date or datetime in local time — YYYY-MM-DD, YYYY-MM-DDTHH:MM, or YYYY-MM-DDTHH:MM:SS"),
        calendar_owner_id: z.number().int().positive().describe("Calendar ID to post this entry to — use list_calendars to find available IDs"),
        description: z.string().optional().describe("Detailed description of the event"),
        all_day: z.boolean().optional().describe("Whether the event spans the full day"),
        matter_id: z.number().int().positive().optional().describe("Matter ID to associate this entry with"),
        location: z.string().optional().describe("Geographic location of the event"),
        send_email_notification: z.boolean().optional().describe("Send email notifications to attendees"),
        attendee_ids: z.array(z.number().int().positive()).optional().describe("List of Clio user IDs to invite as attendees"),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ summary, start_at, end_at, calendar_owner_id, description, all_day, matter_id, location, send_email_notification, attendee_ids }) => {
      try {
        const body: Record<string, unknown> = {
          summary,
          start_at: toIso(start_at),
          end_at: toIso(end_at, true),
          calendar_owner: { id: calendar_owner_id },
        };
        if (description !== undefined)               body.description = description;
        if (all_day !== undefined)                   body.all_day = all_day;
        if (matter_id !== undefined)                 body.matter = { id: matter_id };
        if (location !== undefined)                  body.location = location;
        if (send_email_notification !== undefined)   body.send_email_notification = send_email_notification;
        if (attendee_ids?.length)                    body.attendees = attendee_ids.map((id) => ({ id }));

        const data = await clioPost("/calendar_entries.json", { data: body });
        const entry = data.data as any;

        await appendAuditLog({ tool: "create_calendar_entry", args: { summary, start_at, end_at, calendar_owner_id }, outcome: "success" });

        const result = {
          id: entry.id,
          summary: entry.summary,
          description: entry.description ?? null,
          start_at: entry.start_at,
          end_at: entry.end_at,
          matter: entry.matter ? { id: entry.matter.id, display_number: entry.matter.display_number } : null,
          attendees: (entry.attendees ?? []).map((a: any) => ({ id: a.id, name: a.name })),
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "create_calendar_entry", args: { summary, start_at, end_at, calendar_owner_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
