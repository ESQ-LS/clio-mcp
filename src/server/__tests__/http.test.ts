import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  assertHttpAuthenticationConfigured,
  requireApiKey,
} from "../http.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  process.env.MCP_API_KEY = "synthetic-api-key";
});

function toolCall(name: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: {} },
  };
}

async function unauthenticatedToolRequest(name: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toolCall(name)),
  });
}

describe("HTTP MCP authentication", () => {
  it.each(["get_contact", "update_contact"])(
    "rejects unauthenticated %s requests before tool dispatch",
    async (toolName) => {
      const response = await unauthenticatedToolRequest(toolName);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    },
  );

  it("fails closed when HTTP authentication is not configured", async () => {
    delete process.env.MCP_API_KEY;
    const response = await unauthenticatedToolRequest("get_contact");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "HTTP authentication is not configured" });
    expect(() => assertHttpAuthenticationConfigured()).toThrow("MCP_API_KEY is required in HTTP mode");
  });

  it("accepts the configured bearer credential at the MCP boundary", () => {
    const next = vi.fn();
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    requireApiKey(
      { headers: { authorization: "Bearer synthetic-api-key" } } as any,
      { status, json } as any,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});

describe("public operational and OAuth routes", () => {
  it("keeps health checks available without the MCP bearer credential", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("keeps the OAuth callback public while validating its parameters", async () => {
    const response = await fetch(`${baseUrl}/oauth/callback`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing code or state parameter");
  });
});
