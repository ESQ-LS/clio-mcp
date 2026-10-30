import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, clioPatch } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import {
  consumeWritePreviewToken, makeWritePreviewToken, safeWriteError,
  writeJsonResult, writePreviewEnvelope,
} from "../esq/writePreview.js";
import {
  CLIO_CREATE_TOOL_ANNOTATIONS,
  CLIO_READ_ONLY_TOOL_ANNOTATIONS,
  CLIO_UPDATE_TOOL_ANNOTATIONS,
} from "./annotations.js";

const TASK_FIELDS = "id,etag,name,description,priority,due_at,status,completed_at,notify_completion,assigner{id,name},assignee{id,name},assignees{id,name},matter{id,display_number,description,status},reminders{id,notification_method}";

const STATUS_MAP: Record<string, string> = { Pending: "pending", Complete: "complete", "In Progress": "in_progress", "In Review": "in_review", "Draft": "draft" };
const taskDateSchema = z.string().date();

function buildTaskData(input: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of ["name", "description", "priority"] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  if (input.due_date !== undefined) data.due_at = `${taskDateSchema.parse(input.due_date)}T00:00:00Z`;
  if (input.status !== undefined) data.status = STATUS_MAP[input.status as string];
  if (input.matter_id !== undefined) data.matter = { id: input.matter_id };
  if (input.assignee_id !== undefined) data.assignee = { id: input.assignee_id, type: "User" };
  return data;
}

function completionNotification(current: any, requestedStatus: unknown) {
  if (requestedStatus !== "complete") return undefined;
  const willSend = current.status !== "complete" && current.notify_completion === true;
  if (willSend && (!Number.isInteger(current.assigner?.id) || typeof current.assigner?.name !== "string")) {
    throw new Error("Task completion notification recipient could not be validated.");
  }
  return {
    will_send: willSend,
    recipient: willSend ? { id: current.assigner.id, name: current.assigner.name } : null,
  };
}

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      description: "List tasks from Clio with optional filters",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter tasks by matter ID"),
        status: z.enum(["Pending", "Complete", "In Progress", "In Review", "Draft"]).optional().describe("Filter by task status"),
        due_date_start: taskDateSchema.optional().describe("ISO date (YYYY-MM-DD) — tasks due on or after this date"),
        due_date_end: taskDateSchema.optional().describe("ISO date (YYYY-MM-DD) — tasks due on or before this date"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
      },
      annotations: CLIO_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, status, due_date_start, due_date_end, limit }) => {
      try {
        const params: Record<string, string> = { fields: TASK_FIELDS, limit: String(limit) };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (status) params["status"] = STATUS_MAP[status];
        if (due_date_start) params["due_at_from"] = due_date_start;
        if (due_date_end) params["due_at_to"] = due_date_end;

        const data = await clioGet("/tasks.json", params);
        const tasks = data.data as any[];

        await appendAuditLog({
          tool: "list_tasks",
          args: { matter_id, status, due_date_start, due_date_end, limit },
          outcome: "success",
          result_count: tasks?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        if (!tasks || tasks.length === 0) {
          return { content: [{ type: "text", text: "No tasks found." }] };
        }

        const result = tasks.map((t) => ({
          id: t.id,
          name: t.name,
          priority: t.priority,
          due_date: t.due_at ? t.due_at.substring(0, 10) : null,
          status: t.status,
          assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
          matter: t.matter ? { id: t.matter.id, display_number: t.matter.display_number } : null,
          reminder: t.reminders?.length > 0
            ? { notification_method: t.reminders[0].notification_method }
            : null,
        }));

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_tasks",
          args: { matter_id, status, due_date_start, due_date_end, limit },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a controlled Clio task",
      description: "Dry-run by default. Validates the matter and assignee and displays the complete task. A production write requires confirm_write: true plus the unexpired preview_token from an unchanged proposal.",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Matter ID to associate the task with"),
        name: z.string().min(1).describe("Task name / description"),
        description: z.string().min(2).describe("Detailed description of the task"),
        priority: z.enum(["High", "Normal", "Low"]).default("Normal").describe("Task priority"),
        due_date: taskDateSchema.optional().describe("ISO date (YYYY-MM-DD) when the task is due"),
        assignee_id: z.number().int().positive().optional().describe("Clio user ID to assign the task to"),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_CREATE_TOOL_ANNOTATIONS,
    },
    async ({ matter_id, name, description, priority, due_date, assignee_id, confirm_write, preview_token }) => {
      let writeAttempted = false;
      try {
        const taskData = buildTaskData({ matter_id, name, description, priority, due_date, assignee_id });
        const matter = (await clioGet(`/matters/${matter_id}.json`, { fields: "id,display_number,description,status" }))?.data;
        if (matter?.id !== matter_id) throw new Error("Matter validation failed.");
        const assignee = assignee_id === undefined ? null : (await clioGet(`/users/${assignee_id}.json`, { fields: "id,name,enabled" }))?.data;
        if (assignee_id !== undefined && (assignee?.id !== assignee_id || assignee.enabled === false)) {
          throw new Error("Assignee validation failed.");
        }
        const proposal = {
          matter: { id: matter.id, display_number: matter.display_number, description: matter.description, status: matter.status },
          assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
          task: taskData,
        };
        if (!confirm_write) {
          const auditOk = await appendAuditLog({
            tool: "create_task", action: "create", confirmation_state: "dry_run",
            args: { confirm_write: false, matter_id, priority, due_date, assignee_id }, outcome: "success", matter_id,
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "create_task", proposal, await makeWritePreviewToken("create_task", proposal),
          ));
        }
        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "create_task", proposal);
        const preWriteAuditOk = await appendAuditLog({
          tool: "create_task", action: "create", confirmation_state: "confirmed",
          args: { confirm_write: true, matter_id, priority, due_date, assignee_id }, outcome: "attempt", matter_id,
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;

        const data = await clioPost("/tasks.json", { data: taskData });
        const task = data.data;

        const auditOk = await appendAuditLog({
          tool: "create_task",
          action: "create", confirmation_state: "confirmed",
          args: { confirm_write: true, matter_id, priority, due_date, assignee_id },
          outcome: "success",
          matter_id,
          record_id: task.id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              audit_recorded: auditOk,
              task: {
                id: task.id,
                name: task.name,
                priority: task.priority,
                due_at: task.due_at ? task.due_at.substring(0, 10) : null,
                matter_id,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const message = safeWriteError(err);
        await appendAuditLog({
          tool: "create_task",
          action: "create", confirmation_state: confirm_write ? "confirmed" : "dry_run",
          args: { confirm_write, matter_id, priority, due_date, assignee_id },
          outcome: "error",
          error_message: message,
          matter_id,
        });
        return writeJsonResult({ error: message, write_performed: writeAttempted ? "unknown" : false }, true);
      }
    }
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a controlled Clio task",
      description: "Dry-run by default. Reads the current task, validates changed references, and displays the exact changes. A production write requires confirm_write: true plus an unchanged preview_token and current ETag.",
      inputSchema: {
        task_id: z.number().int().positive().describe("ID of the task to update"),
        name: z.string().min(1).optional().describe("New task name"),
        description: z.string().optional().describe("New task description"),
        priority: z.enum(["High", "Normal", "Low"]).optional().describe("New priority"),
        due_date: taskDateSchema.optional().describe("ISO date (YYYY-MM-DD) for due date"),
        status: z.enum(["Pending", "Complete", "In Progress", "In Review", "Draft"]).optional().describe("New task status"),
        assignee_id: z.number().int().positive().optional().describe("Clio user ID to reassign the task to"),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_UPDATE_TOOL_ANNOTATIONS,
    },
    async ({ task_id, name, description, priority, due_date, status, assignee_id, confirm_write, preview_token }) => {
      if ([name, description, priority, due_date, status, assignee_id].every((v) => v === undefined)) {
        return { content: [{ type: "text", text: "Error: at least one field to update must be provided" }], isError: true };
      }
      let writeAttempted = false;
      try {
        const taskData = buildTaskData({ name, description, priority, due_date, status, assignee_id });
        const current = (await clioGet(`/tasks/${task_id}.json`, { fields: TASK_FIELDS }))?.data;
        if (current?.id !== task_id) throw new Error("Task validation failed.");
        if (typeof current.etag !== "string" || !current.etag.trim()) throw new Error("Clio did not return a task ETag; no update can be performed safely.");
        const assignee = assignee_id === undefined ? null : (await clioGet(`/users/${assignee_id}.json`, { fields: "id,name,enabled" }))?.data;
        if (assignee_id !== undefined && (assignee?.id !== assignee_id || assignee.enabled === false)) throw new Error("Assignee validation failed.");
        const notification = completionNotification(current, taskData.status);
        const proposal = {
          record_id: task_id, current_etag: current.etag,
          current: {
            name: current.name, description: current.description, priority: current.priority,
            due_at: current.due_at, status: current.status, assignee: current.assignee,
            assignees: current.assignees ?? [], matter: current.matter,
          },
          changes: taskData,
          assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
          ...(notification && { completion_notification: notification }),
          ...(assignee_id !== undefined && (current.assignees?.length ?? 0) > 1 && {
            assignee_replacement: {
              warning: "Replacing the singular assignee will remove the other firm-user assignees.",
              removed_assignees: current.assignees
                .filter((candidate: any) => candidate.id !== assignee_id)
                .map((candidate: any) => ({ id: candidate.id, name: candidate.name })),
            },
          }),
        };
        if (!confirm_write) {
          const auditOk = await appendAuditLog({
            tool: "update_task", action: "update", confirmation_state: "dry_run",
            args: { confirm_write: false, task_id, fields_changed: Object.keys(taskData) }, outcome: "success",
            ...(current.matter?.id && { matter_id: current.matter.id }),
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "update_task", proposal, await makeWritePreviewToken("update_task", proposal),
          ));
        }
        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "update_task", proposal);
        const preWriteAuditOk = await appendAuditLog({
          tool: "update_task", action: "update", confirmation_state: "confirmed",
          args: { confirm_write: true, task_id, fields_changed: Object.keys(taskData) }, outcome: "attempt",
          ...(current.matter?.id && { matter_id: current.matter.id }),
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;

        const data = await clioPatch(`/tasks/${task_id}.json`, { data: taskData }, { "If-Match": current.etag });
        const task = data.data;

        const auditOk = await appendAuditLog({
          tool: "update_task",
          action: "update", confirmation_state: "confirmed",
          args: { confirm_write: true, task_id, fields_changed: Object.keys(taskData) },
          outcome: "success",
          ...(task.matter?.id && { matter_id: task.matter.id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              audit_recorded: auditOk,
              task: {
                id: task.id,
                name: task.name,
                priority: task.priority,
                status: task.status,
                due_date: task.due_at ? task.due_at.substring(0, 10) : null,
                matter_id: task.matter?.id ?? null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const message = safeWriteError(err);
        await appendAuditLog({
          tool: "update_task",
          action: "update", confirmation_state: confirm_write ? "confirmed" : "dry_run",
          args: { confirm_write, task_id },
          outcome: "error",
          error_message: message,
        });
        return writeJsonResult({ error: message, write_performed: writeAttempted ? "unknown" : false }, true);
      }
    }
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a controlled Clio task",
      description: "Dry-run by default. Displays the exact task and matter before completion. A production write requires confirm_write: true plus an unchanged preview_token and current ETag.",
      inputSchema: {
        task_id: z.number().int().positive().describe("ID of the task to mark complete"),
        confirm_write: z.boolean().default(false),
        preview_token: z.string().optional(),
      },
      annotations: CLIO_UPDATE_TOOL_ANNOTATIONS,
    },
    async ({ task_id, confirm_write, preview_token }) => {
      let writeAttempted = false;
      try {
        const current = (await clioGet(`/tasks/${task_id}.json`, { fields: TASK_FIELDS }))?.data;
        if (current?.id !== task_id) throw new Error("Task validation failed.");
        if (typeof current.etag !== "string" || !current.etag.trim()) throw new Error("Clio did not return a task ETag; no update can be performed safely.");
        const notification = completionNotification(current, STATUS_MAP["Complete"]);
        const proposal = {
          record_id: task_id, current_etag: current.etag,
          current: { name: current.name, status: current.status, due_at: current.due_at, matter: current.matter },
          changes: { status: STATUS_MAP["Complete"] },
          completion_notification: notification,
        };
        if (!confirm_write) {
          const auditOk = await appendAuditLog({
            tool: "complete_task", action: "update", confirmation_state: "dry_run",
            args: { confirm_write: false, task_id }, outcome: "success",
            ...(current.matter?.id && { matter_id: current.matter.id }),
          });
          if (!auditOk) throw new Error("Audit persistence failed; dry-run could not be recorded.");
          return writeJsonResult(writePreviewEnvelope(
            "complete_task", proposal, await makeWritePreviewToken("complete_task", proposal),
          ));
        }
        if (!preview_token) throw new Error("preview_token is required when confirm_write is true.");
        await consumeWritePreviewToken(preview_token, "complete_task", proposal);
        const preWriteAuditOk = await appendAuditLog({
          tool: "complete_task", action: "update", confirmation_state: "confirmed",
          args: { confirm_write: true, task_id }, outcome: "attempt",
          ...(current.matter?.id && { matter_id: current.matter.id }),
        });
        if (!preWriteAuditOk) throw new Error("Audit persistence failed; no Clio write was attempted.");
        writeAttempted = true;
        const data = await clioPatch(`/tasks/${task_id}.json`, { data: { status: STATUS_MAP["Complete"] } }, { "If-Match": current.etag });
        const task = data.data;

        const auditOk = await appendAuditLog({
          tool: "complete_task",
          action: "update", confirmation_state: "confirmed", args: { confirm_write: true, task_id },
          outcome: "success",
          ...(task.matter?.id && { matter_id: task.matter.id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              audit_recorded: auditOk,
              task: {
                id: task.id,
                name: task.name,
                status: task.status,
                completed_at: task.completed_at ?? null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const message = safeWriteError(err);
        await appendAuditLog({
          tool: "complete_task",
          action: "update", confirmation_state: confirm_write ? "confirmed" : "dry_run",
          args: { confirm_write, task_id },
          outcome: "error",
          error_message: message,
        });
        return writeJsonResult({ error: message, write_performed: writeAttempted ? "unknown" : false }, true);
      }
    }
  );
}
