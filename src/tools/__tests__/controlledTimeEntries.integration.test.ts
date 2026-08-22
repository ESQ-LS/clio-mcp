import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyWriteGate } from "../../esq/writeGate.js";
import { registerControlledTimeEntryTools } from "../controlledTimeEntries.js";

afterEach(() => { delete process.env.ESQ_WRITE_TOOLS; });

describe("controlled time-entry MCP schema integration", () => {
  it("publishes only the allowlisted create/update schemas with confirmation controls", async () => {
    process.env.ESQ_WRITE_TOOLS = "create_time_entry,update_time_entry";
    const server = new McpServer({ name: "synthetic-clio-mcp", version: "test" });
    applyWriteGate(server);
    registerControlledTimeEntryTools(server);

    const client = new Client({ name: "synthetic-client", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
      expect(Object.keys(byName).sort()).toEqual(["create_time_entry", "update_time_entry"]);
      expect(byName.create_time_entry.inputSchema.required).toEqual(expect.arrayContaining([
        "matter_id", "date", "user_id", "quantity_in_hours", "rate", "narrative",
        "activity_description_id", "supporting_evidence",
      ]));
      expect(byName.create_time_entry.inputSchema.properties).toHaveProperty("confirm_write");
      expect(byName.create_time_entry.inputSchema.properties).toHaveProperty("preview_token");
      expect(byName.update_time_entry.inputSchema.required).toEqual(expect.arrayContaining([
        "activity_id", "etag", "supporting_evidence",
      ]));
      expect(byName.update_time_entry.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(byName).not.toHaveProperty("delete_time_entry");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
