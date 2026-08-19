import express from "express";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAuthTools } from "../auth/authTools.js";
import { registerResources } from "../resources/index.js";
import { registerMatterTools } from "../tools/matters.js";
import { registerContactTools } from "../tools/contacts.js";
import { registerDocumentTools } from "../tools/documents.js";
import { registerTaskTools } from "../tools/tasks.js";
import { registerCalendarTools } from "../tools/calendar.js";
import { registerActivityTools } from "../tools/activities.js";
import { registerBillingTools } from "../tools/billing.js";
import { registerCommunicationTools } from "../tools/communications.js";
import { registerNoteTools } from "../tools/notes.js";
import { applyWriteGate } from "../esq/writeGate.js";
import { registerUserTools } from "../tools/users.js";
import { registerAuditExportTool } from "../tools/auditExport.js";
import {
  exchangeCodeForTokensPure,
  refreshTokensPure,
  resolveClioUserId,
  validateAuthorizationState,
} from "../auth/oauth.js";
import type { ClioTokens } from "../auth/oauth.js";
import { loadTokens, saveTokens } from "../auth/tokenStorage.js";
import { sessionStorage, SessionContext } from "../utils/sessionContext.js";
import { appendAuditLog } from "../utils/auditLog.js";

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer | null;
  tokens: ClioTokens | null;
  createdAt: number;
}

const sessions = new Map<string, SessionRecord>();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "clio-mcp", version: pkg.version });
  applyWriteGate(server); // ESQ fork: withhold Clio-mutating tools unless allowlisted
  registerAuthTools(server);
  registerResources(server);
  registerMatterTools(server);
  registerContactTools(server);
  registerDocumentTools(server);
  registerTaskTools(server);
  registerCalendarTools(server);
  registerActivityTools(server);
  registerBillingTools(server);
  registerCommunicationTools(server);
  registerNoteTools(server);
  registerUserTools(server);
  registerAuditExportTool(server);
  return server;
}

function buildSessionContext(record: SessionRecord, sessionId: string): SessionContext {
  return {
    sessionId,
    getAccessToken: async () => {
      let tokens = record.tokens ?? await loadTokens();
      if (!tokens) {
        throw new Error(
          "Not authenticated. Call the 'authenticate' tool to get a login URL, " +
          "complete OAuth in your browser, then try again."
        );
      }

      if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
        const refreshed = await refreshTokensPure(tokens.refresh_token);
        tokens = {
          ...refreshed,
          clio_user_id: tokens.clio_user_id,
          user_id_unavailable: tokens.user_id_unavailable,
        };
        await saveTokens(tokens);
      }

      record.tokens = tokens;
      return tokens.access_token;
    },
    storeTokens: (tokens: ClioTokens) => { record.tokens = tokens; },
    getTokens: () => record.tokens,
    clearTokens: () => { record.tokens = null; },
    setPendingNonce: () => {},
  };
}

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, rec] of sessions) {
    if (rec.createdAt < cutoff) {
      rec.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 60 * 1000).unref();

function requireApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const key = process.env.MCP_API_KEY;
  if (!key) { next(); return; }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${key}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.all("/mcp", requireApiKey, express.json(), async (req, res) => {
  try {
    const incomingSessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!incomingSessionId) {
      const record: SessionRecord = {
        transport: null!,
        mcpServer: null,
        tokens: null,
        createdAt: Date.now(),
      };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: async (sessionId) => {
          record.mcpServer = createMcpServer();
          sessions.set(sessionId, record);
          await record.mcpServer.connect(transport);
        },
        onsessionclosed: (sessionId) => {
          sessions.delete(sessionId);
        },
      });
      record.transport = transport;

      const tempCtx: SessionContext = {
        sessionId: "",
        getAccessToken: async () => { throw new Error("Not authenticated"); },
        storeTokens: () => {},
        getTokens: () => null,
        clearTokens: () => {},
        setPendingNonce: () => {},
      };

      await sessionStorage.run(tempCtx, () => transport.handleRequest(req, res, req.body));
    } else {
      const record = sessions.get(incomingSessionId);
      if (!record) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const ctx = buildSessionContext(record, incomingSessionId);
      await sessionStorage.run(ctx, () => record.transport.handleRequest(req, res, req.body));
    }
  } catch (err: any) {
    console.error("[http] /mcp error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/oauth/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>;

  if (oauthError) {
    res.status(400).send(
      `<h1>Authentication Error</h1><p>${oauthError}</p><p>You can close this tab.</p>`
    );
    return;
  }

  if (!code || !state) {
    res.status(400).send("<h1>Bad Request</h1><p>Missing code or state parameter.</p>");
    return;
  }

  let sessionId: string;
  try {
    ({ session_id: sessionId } = validateAuthorizationState(state));
  } catch (err: any) {
    res.status(400).send(`<h1>Invalid State</h1><p>${err.message}</p>`);
    return;
  }

  try {
    const baseUrl = (process.env.MCP_BASE_URL ?? "").trim().replace(/\/+$/, "");
    const redirectUri = `${baseUrl}/oauth/callback`;
    const tokens = await exchangeCodeForTokensPure(code, redirectUri);
    await resolveClioUserId(tokens);

    // Persist independently of the MCP transport session. The browser callback may
    // arrive after the originating MCP session was closed.
    await saveTokens(tokens);

    const record = sessions.get(sessionId);
    if (record) record.tokens = tokens;

    await appendAuditLog({
      tool: "oauth_callback",
      args: {},
      outcome: "success",
      clio_user_id: tokens.clio_user_id,
    });

    res.send(
      `<!DOCTYPE html><html><head><title>Authentication Successful</title></head>` +
      `<body><h1>Authentication Successful</h1>` +
      `<p>You are now connected to Clio. You can close this tab and return to ChatGPT.</p>` +
      `</body></html>`
    );
  } catch (err: any) {
    console.error("[http] OAuth callback error:", err.message);
    res.status(500).send(
      `<h1>Authentication Failed</h1><p>${err.message}</p><p>Please try authenticating again.</p>`
    );
  }
});

export function startHttpServer(): void {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    const baseUrl = (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${port}`).trim();
    console.error(`[http] Clio MCP server listening on port ${port}`);
    console.error(`[http] MCP endpoint : ${baseUrl}/mcp`);
    console.error(`[http] Health check : ${baseUrl}/health`);
  });
}
