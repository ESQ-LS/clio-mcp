import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyWriteGate } from "../writeGate.js";

function registeredWith(writeTools: string, transport = "stdio", apiKey?: string): string[] {
  process.env.ESQ_WRITE_TOOLS = writeTools;
  process.env.TRANSPORT = transport;
  if (apiKey) process.env.MCP_API_KEY = apiKey;
  else delete process.env.MCP_API_KEY;
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
  server.registerTool("create_contact", {} as any, vi.fn());
  server.registerTool("update_contact", {} as any, vi.fn());
  server.registerTool("create_matter", {} as any, vi.fn());
  server.registerTool("update_matter", {} as any, vi.fn());
  server.registerTool("upload_document", {} as any, vi.fn());
  return names;
}

afterEach(() => {
  delete process.env.ESQ_WRITE_TOOLS;
  delete process.env.TRANSPORT;
  delete process.env.MCP_API_KEY;
});

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

  it("exposes only expressly allowlisted intake writes", () => {
    expect(registeredWith("create_contact,update_contact,create_matter,update_matter")).toEqual([
      "list_time_entries",
      "create_contact",
      "update_contact",
      "create_matter",
      "update_matter",
    ]);
  });

  it("exposes document upload only when expressly allowlisted", () => {
    expect(registeredWith("upload_document")).toEqual([
      "list_time_entries",
      "upload_document",
    ]);
  });

  it("fails closed for HTTP writes without an MCP API key", () => {
    expect(registeredWith("create_contact,update_matter", "http")).toEqual(["list_time_entries"]);
  });

  it("permits allowlisted HTTP writes when MCP authentication is configured", () => {
    expect(registeredWith("create_contact,update_matter", "http", "synthetic-api-key")).toEqual([
      "list_time_entries", "create_contact", "update_matter",
    ]);
  });
});
