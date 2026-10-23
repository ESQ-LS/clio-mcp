import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { CLIO_CREATE_TOOL_ANNOTATIONS, CLIO_READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";
import {
  consumeWritePreviewToken, makeWritePreviewToken, safeWriteError,
  writeJsonResult, writePreviewEnvelope,
} from "../esq/writePreview.js";

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
      title: "Create a controlled Clio calendar entry",
      description: "Dry-run by default. Validates the calendar, matter, and attendees and displays the complete event, including whether email notifications will be sent. A production write requires confirm_write: true plus the unexpired preview_token from an unchanged proposal.",
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
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ summary, start_at, end_at, calendar_owner_id, description, all_day, matter_id, location, send_email_notification, attendee_ids, confirm_write, preview_token }) => {
      let writeAttempted = false;
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

        const calendar = (await clioGet(`/calendars/${calendar_owner_id}.json`, { fields: "id,name,type" }))?.data;
        if (calendar?.id !== calendar_owner_id) throw new Error("Calendar validation failed.");
        const matter = matter_id === undefined ? null : (await clioGet(`/matters/${matter_id}.json`, {
          fields: "id,display_number,description,status",
        }))?.data;
        if (matter_id !== undefined && matter?.id !== matter_id) throw new Error("Matter validation failed.");
        const attendees = [];
        for (const attendeeId of attendee_ids ?? []) {
          const user = (await clioGet(`/users/${attendeeId}.json`, { fields: "id,name,enabled" }))?.data;
          if (user?.id !== attendeeId || user.enabled === false) throw new Error(`Attendee ${attendeeId} validation failed.`);
          attendees.push({ id: user.id, name: user.name });
        }
        const proposal = {
          calendar: { id: calendar.id, name: calendar.name, type: calendar.type },
          matter: matter ? { id: matter.id, display_number: matter.display_number, description: matter.description, status: matter.status } : null,
          attendees,
          event: { ...body, send_email_notification: send_email_notification ?? false },
        };
        if (!confirm_write) {
          const auditOk = await appendAuditLog({
            tool: "create_calendar_entry", action: "create", confirmation_state: "dry_run",
            args: { confirm_write: false, summary, start_at, end_at, calendar_owner_id, matter_id, send_email_notification: send_email_notification ?? false },
            outcome: "success", ...(matter_id && { matter_id }),
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_calendar_entry", proposal,
            await makeWritePreviewToken("create_calendar_entry", proposal),
          ));
        }
        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "create_calendar_entry", proposal);
        const preWriteAuditOk = await appendAuditLog({
          tool: "create_calendar_entry", action: "create", confirmation_state: "confirmed",
          args: { confirm_write: true, summary, start_at, end_at, calendar_owner_id, matter_id, send_email_notification: send_email_notification ?? false },
          outcome: "success", ...(matter_id && { matter_id }),
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;

        const data = await clioPost("/calendar_entries.json", { data: body });
        const entry = data.data as any;

        await appendAuditLog({ tool: "create_calendar_entry", action: "create", confirmation_state: "confirmed", args: { confirm_write: true, summary, start_at, end_at, calendar_owner_id, matter_id }, outcome: "success", ...(matter_id && { matter_id }) });

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
        const message = safeWriteError(err);
        await appendAuditLog({ tool: "create_calendar_entry", action: "create", confirmation_state: confirm_write ? "confirmed" : "dry_run", args: { confirm_write, summary, start_at, end_at, calendar_owner_id, matter_id }, outcome: "error", error_message: message, ...(matter_id && { matter_id }) });
        return writeJsonResult({
          error: message,
          write_performed: writeAttempted ? "unknown" : false,
          ...(writeAttempted && { recovery: "Search the target calendar before retrying; the API outcome may be ambiguous." }),
        }, true);
      }
    }
  );
}
