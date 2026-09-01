import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthTools } from "../../auth/authTools.js";
import { applyWriteGate } from "../../esq/writeGate.js";
import { registerActivityTools } from "../activities.js";
import { registerAuditExportTool } from "../auditExport.js";
import { registerBillingTools } from "../billing.js";
import { registerCalendarTools } from "../calendar.js";
import { registerCommunicationTools } from "../communications.js";
import { registerContactTools } from "../contacts.js";
import { registerControlledTimeEntryTools } from "../controlledTimeEntries.js";
import { registerDocumentTools } from "../documents.js";
import { registerMatterTools } from "../matters.js";
import { registerNoteTools } from "../notes.js";
import { registerTaskTools } from "../tasks.js";
import { registerUserTools } from "../users.js";

const CLIO_READ_TOOLS = [
  "get_billing_summary",
  "get_contact",
  "get_document",
  "get_matter",
  "get_time_entry",
  "get_user",
  "list_activity_descriptions",
  "list_bills",
  "list_calendar_entries",
  "list_calendars",
  "list_communications",
  "list_documents",
  "list_matters",
  "list_tasks",
  "list_time_entries",
  "list_users",
  "search_contacts",
] as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const ADDITIVE_WRITE_TOOLS = [
  "create_activity",
  "create_calendar_entry",
  "create_matter",
  "create_note",
  "create_task",
  "create_time_entry",
  "log_time_entry",
  "upload_document",
] as const;

const DESTRUCTIVE_UPDATE_TOOLS = [
  "complete_task",
  "update_task",
  "update_time_entry",
] as const;

afterEach(() => {
  delete process.env.ESQ_WRITE_TOOLS;
});

function registerAllTools(server: McpServer): void {
  registerAuthTools(server);
  registerMatterTools(server);
  registerContactTools(server);
  registerDocumentTools(server);
  registerTaskTools(server);
  registerCalendarTools(server);
  registerActivityTools(server);
  registerControlledTimeEntryTools(server);
  registerBillingTools(server);
  registerCommunicationTools(server);
  registerNoteTools(server);
  registerUserTools(server);
  registerAuditExportTool(server);
}

async function discoverTools(productionGate: boolean) {
  const server = new McpServer({ name: "synthetic-clio-mcp", version: "test" });
  if (productionGate) {
    process.env.ESQ_WRITE_TOOLS = "create_time_entry,update_time_entry";
    applyWriteGate(server);
  }
  registerAllTools(server);

  const client = new Client({ name: "synthetic-client", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, tools: (await client.listTools()).tools };
}

describe("read-only MCP annotations", () => {
  it("publishes exact safety annotations for every production-exposed action", async () => {
    const { client, server, tools } = await discoverTools(true);

    try {
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

      expect(Object.keys(byName).sort()).toEqual([
        "auth_status",
        "authenticate",
        "create_time_entry",
        "export_audit_log",
        "get_billing_summary",
        "get_contact",
        "get_document",
        "get_matter",
        "get_time_entry",
        "get_user",
        "list_activity_descriptions",
        "list_bills",
        "list_calendar_entries",
        "list_calendars",
        "list_communications",
        "list_documents",
        "list_matters",
        "list_tasks",
        "list_time_entries",
        "list_users",
        "logout",
        "search_contacts",
        "update_time_entry",
      ]);

      for (const name of CLIO_READ_TOOLS) {
        expect(byName[name]?.annotations, name).toEqual(READ_ONLY_ANNOTATIONS);
      }

      for (const name of ["auth_status", "export_audit_log"] as const) {
        expect(byName[name]?.annotations, name).toEqual(READ_ONLY_ANNOTATIONS);
      }

      expect(byName.authenticate.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(byName.logout.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(byName.create_time_entry.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(byName.update_time_entry.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });

      for (const name of Object.keys(byName)) {
        expect(byName[name].annotations, name).toBeDefined();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("classifies every registered action before deployment gating", async () => {
    const { client, server, tools } = await discoverTools(false);
    try {
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      const expectedNames = [
        ...CLIO_READ_TOOLS,
        "auth_status",
        "export_audit_log",
        "authenticate",
        "logout",
        ...ADDITIVE_WRITE_TOOLS,
        ...DESTRUCTIVE_UPDATE_TOOLS,
      ].sort();
      expect(Object.keys(byName).sort()).toEqual(expectedNames);

      for (const name of ADDITIVE_WRITE_TOOLS) {
        expect(byName[name].annotations, name).toEqual({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        });
      }
      for (const name of DESTRUCTIVE_UPDATE_TOOLS) {
        expect(byName[name].annotations, name).toEqual({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        });
      }
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toBeDefined();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
