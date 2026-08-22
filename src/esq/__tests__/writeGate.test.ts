import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyWriteGate } from "../writeGate.js";

function registeredWith(writeTools: string): string[] {
  process.env.ESQ_WRITE_TOOLS = writeTools;
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => { names.push(name); },
  } as unknown as McpServer;
  applyWriteGate(server);
  server.registerTool("list_time_entries", {} as any, vi.fn());
  server.registerTool("create_time_entry", {} as any, vi.fn());
  server.registerTool("update_time_entry", {} as any, vi.fn());
  server.registerTool("log_time_entry", {} as any, vi.fn());
  server.registerTool("create_activity", {} as any, vi.fn());
  return names;
}

afterEach(() => { delete process.env.ESQ_WRITE_TOOLS; });

describe("ESQ controlled time-entry write gate", () => {
  it("withholds every write tool by default", () => {
    expect(registeredWith("")).toEqual(["list_time_entries"]);
  });

  it("exposes only the two expressly allowlisted controlled tools", () => {
    expect(registeredWith("create_time_entry,update_time_entry")).toEqual([
      "list_time_entries",
      "create_time_entry",
      "update_time_entry",
    ]);
  });
});
