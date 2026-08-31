import { describe, expect, it } from "vitest";
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

describe("read-only MCP annotations", () => {
  it("marks every default lookup as non-destructive while leaving auth actions distinct", async () => {
    const server = new McpServer({ name: "synthetic-clio-mcp", version: "test" });
    applyWriteGate(server);
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

    const client = new Client({ name: "synthetic-client", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));

      for (const name of CLIO_READ_TOOLS) {
        expect(byName[name]?.annotations, name).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        });
      }

      for (const name of ["auth_status", "export_audit_log"] as const) {
        expect(byName[name]?.annotations, name).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
      }

      const unannotated = listed.tools
        .filter((tool) => tool.annotations?.readOnlyHint !== true)
        .map((tool) => tool.name)
        .sort();
      expect(unannotated).toEqual(["authenticate", "logout"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
