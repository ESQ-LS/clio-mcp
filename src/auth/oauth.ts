import http from "http";
import crypto from "crypto";
import { saveTokens, loadTokens } from "./tokenStorage.js";

const HTTP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function getClioBase() {
  const region = (process.env.CLIO_REGION ?? "us").toLowerCase();
  if (region === "eu") return "https://eu.app.clio.com";
  if (region === "ca") return "https://ca.app.clio.com";
  return "https://app.clio.com";
}

export function getClioApiBase(): string {
  return (process.env.CLIO_API_BASE ?? `${getClioBase()}/api/v4`).replace(/\/+$/, "");
}

function getAuthUrl() { return process.env.CLIO_AUTH_URL ?? `${getClioBase()}/oauth/authorize`; }
function getTokenUrl() { return process.env.CLIO_TOKEN_URL ?? `${getClioBase()}/oauth/token`; }

function getOAuthStateSigningKey(): string {
  const key = (process.env.OAUTH_STATE_SECRET ?? process.env.CLIO_CLIENT_SECRET ?? "").trim();
  if (!key) throw new Error("OAUTH_STATE_SECRET or CLIO_CLIENT_SECRET is required for HTTP OAuth state signing.");
  return key;
}

export interface ClioTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  clio_user_id?: string;
  user_id_unavailable?: boolean;
}

interface HttpOAuthState {
  session_id: string;
  nonce: string;
  issued_at: number;
}

export async function runOAuthFlow(): Promise<ClioTokens> {
  const clientId = (process.env.CLIO_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.CLIO_CLIENT_SECRET ?? "").trim();
  const port = (process.env.CLIO_REDIRECT_PORT || "5678").trim();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = `${getAuthUrl()}?` + new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });

  const { default: open } = await import("open");
  await open(authUrl);
  console.error(`[auth] Please complete the login in your browser...`);

  const code = await waitForCallback(port, state);
  const tokens = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);
  await resolveClioUserId(tokens);
  await saveTokens(tokens);
  console.error(`[auth] Authentication successful, tokens saved.`);
  return tokens;
}

function waitForCallback(port: string, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") return;

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });

      if (error || !code) {
        res.end(`<h1>Error: ${error || "No code received"}</h1><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (state !== expectedState) {
        res.end(`<h1>Error: Invalid state parameter</h1>`);
        server.close();
        reject(new Error("State mismatch - possible CSRF attack"));
        return;
      }

      res.end(`<h1>Authentication successful!</h1><p>You can close this tab and continue.</p>`);
      server.close();
      resolve(code);
    });

    server.listen(parseInt(port), "127.0.0.1", () => {
      console.error(`[auth] Waiting for callback on http://127.0.0.1:${port}/callback`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout - no response received within 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<ClioTokens> {
  const tokenUrl = getTokenUrl();
  console.error(`[auth] Token exchange -> POST ${tokenUrl}`);
  console.error(`[auth]   client_id   : ${clientId.substring(0, 8)}...`);
  console.error(`[auth]   redirect_uri: ${redirectUri}`);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  console.error(`[auth] Token response: HTTP ${res.status}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Token exchange failed.\n` +
      `  Token URL  : ${tokenUrl}\n` +
      `  Redirect   : ${redirectUri}\n` +
      `  client_id  : ${clientId.substring(0, 6)}... (length ${clientId.length})\n` +
      `  Response   : ${err}\n` +
      `\nIf the error is \"invalid_client\": verify CLIO_CLIENT_ID and CLIO_CLIENT_SECRET match your Clio developer app exactly.`
    );
  }

  const data = await res.json() as any;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

function signOAuthState(payload: string): string {
  return crypto.createHmac("sha256", getOAuthStateSigningKey()).update(payload).digest("base64url");
}

export function buildAuthorizationUrl(sessionId: string): { url: string; nonce: string } {
  const clientId = (process.env.CLIO_CLIENT_ID ?? "").trim();
  const baseUrl = (process.env.MCP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("MCP_BASE_URL is required for HTTP OAuth.");
  const redirectUri = `${baseUrl}/oauth/callback`;
  const nonce = crypto.randomBytes(16).toString("hex");
  const stateData: HttpOAuthState = { session_id: sessionId, nonce, issued_at: Date.now() };
  const payload = Buffer.from(JSON.stringify(stateData), "utf8").toString("base64url");
  const state = `${payload}.${signOAuthState(payload)}`;

  const url = `${getAuthUrl()}?` + new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return { url, nonce };
}

export function validateAuthorizationState(state: string, now = Date.now()): HttpOAuthState {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) throw new Error("Invalid OAuth state format.");

  const expected = Buffer.from(signOAuthState(payload), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Invalid OAuth state signature.");
  }

  let decoded: HttpOAuthState;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HttpOAuthState;
  } catch {
    throw new Error("Invalid OAuth state payload.");
  }

  if (!decoded.session_id || !decoded.nonce || !Number.isFinite(decoded.issued_at)) {
    throw new Error("Incomplete OAuth state payload.");
  }
  if (decoded.issued_at > now + 60_000 || now - decoded.issued_at > HTTP_OAUTH_STATE_TTL_MS) {
    throw new Error("OAuth state has expired.");
  }
  return decoded;
}

export async function exchangeCodeForTokensPure(code: string, redirectUri: string): Promise<ClioTokens> {
  const clientId = (process.env.CLIO_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.CLIO_CLIENT_SECRET ?? "").trim();
  return exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);
}

export async function refreshTokensPure(refreshToken: string): Promise<ClioTokens> {
  const clientId = (process.env.CLIO_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.CLIO_CLIENT_SECRET ?? "").trim();
  const res = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed, please re-authenticate.");
  const data = await res.json() as any;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function resolveClioUserId(tokens: ClioTokens): Promise<void> {
  if (tokens.clio_user_id || tokens.user_id_unavailable) return;
  try {
    const meRes = await fetch(`${getClioApiBase()}/users/who_am_i.json`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json() as any;
      const userId = me.data?.id ? String(me.data.id) : undefined;
      if (userId) tokens.clio_user_id = userId;
    } else if (meRes.status === 403) {
      tokens.user_id_unavailable = true;
    }
  } catch {
    // Non-fatal: authentication remains valid even if user lookup fails.
  }
}

export async function getValidAccessToken(): Promise<string> {
  let tokens = await loadTokens();
  if (!tokens) tokens = await runOAuthFlow();

  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    console.error("[auth] Token expiring soon, refreshing...");
    tokens = await refreshAccessToken(tokens);
  }

  if (!tokens.clio_user_id && !tokens.user_id_unavailable) {
    await resolveClioUserId(tokens);
    await saveTokens(tokens);
  }
  return tokens.access_token;
}

async function refreshAccessToken(tokens: ClioTokens): Promise<ClioTokens> {
  const refreshed = await refreshTokensPure(tokens.refresh_token);
  const newTokens: ClioTokens = {
    ...refreshed,
    clio_user_id: tokens.clio_user_id,
    user_id_unavailable: tokens.user_id_unavailable,
  };
  await saveTokens(newTokens);
  return newTokens;
}
