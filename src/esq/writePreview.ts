import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { loadTokens } from "../auth/tokenStorage.js";
import { getSessionContext } from "../utils/sessionContext.js";
import { ClioApiError, getClioBaseUrl } from "../utils/clioClient.js";

const PREVIEW_TTL_MS = 15 * 60 * 1000;

interface PreviewClaims {
  version: 1;
  action: string;
  fingerprint: string;
  issued_at: number;
  nonce: string;
  actor: string;
  process_id: string;
}

const consumedPreviewNonces = new Map<string, number>();
// Tokens cannot be replayed after a process restart or on another replica.
const processId = randomUUID();

async function authenticatedActor(): Promise<string> {
  const ctx = getSessionContext();
  // In HTTP mode, never fall back to another user's persisted credentials.
  const tokens = ctx ? ctx.getTokens() : await loadTokens();
  if (!tokens?.clio_user_id || !Number.isFinite(tokens.expires_at) || tokens.expires_at <= Date.now()) {
    throw new Error("A current authenticated Clio user is required for write previews.");
  }
  return `${getClioBaseUrl()}:${tokens.clio_user_id}`;
}

export function safeWriteError(error: unknown): string {
  // Clio validation errors may echo client input; keep it out of audit entries.
  if (error instanceof ClioApiError) return `Clio API request failed with status ${error.statusCode}.`;
  return error instanceof Error ? error.message : "Unknown error";
}

function previewSecret(): Buffer {
  const value = process.env.ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("Server configuration error: ENCRYPTION_KEY is required for write-preview tokens.");
  }
  return createHmac("sha256", value).update("esq-clio-record-write-preview-v1").digest();
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export async function makeWritePreviewToken(action: string, proposal: unknown, now = Date.now()): Promise<string> {
  const claims: PreviewClaims = {
    version: 1,
    action,
    fingerprint: fingerprint(proposal),
    issued_at: now,
    nonce: randomUUID(),
    actor: await authenticatedActor(),
    process_id: processId,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", previewSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function consumeWritePreviewToken(
  token: string,
  action: string,
  proposal: unknown,
  now = Date.now(),
): Promise<void> {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) throw new Error("Invalid preview token.");
  const expectedSignature = createHmac("sha256", previewSecret()).update(payload).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Invalid preview token.");
  }

  let claims: PreviewClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid preview token.");
  }
  if (claims.version !== 1 || claims.action !== action || claims.fingerprint !== fingerprint(proposal)) {
    throw new Error("The proposal changed after preview. Run a new dry-run before confirming.");
  }
  if (claims.actor !== await authenticatedActor() || claims.process_id !== processId) {
    throw new Error("The authenticated user or server changed after preview. Run a new dry-run before confirming.");
  }
  if (!Number.isFinite(claims.issued_at) || claims.issued_at > now || now - claims.issued_at > PREVIEW_TTL_MS) {
    throw new Error("The preview token expired. Run a new dry-run before confirming.");
  }
  if (!claims.nonce || consumedPreviewNonces.has(claims.nonce)) {
    throw new Error("This preview token has already been used. Run a new dry-run before confirming another write.");
  }
  for (const [nonce, consumedAt] of consumedPreviewNonces) {
    if (now - consumedAt > PREVIEW_TTL_MS) consumedPreviewNonces.delete(nonce);
  }
  consumedPreviewNonces.set(claims.nonce, now);
}

export function writePreviewEnvelope(
  action: string,
  proposal: unknown,
  previewToken: string,
  context: Record<string, unknown> = {},
) {
  return {
    mode: "dry_run",
    write_performed: false,
    action,
    proposal,
    ...context,
    preview_token: previewToken,
    preview_expires_in_minutes: PREVIEW_TTL_MS / 60000,
    next_step:
      "Review every displayed field. To perform this exact mutation, call the same tool with unchanged inputs, confirm_write: true, and this preview_token.",
  };
}

export function writeJsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError && { isError: true }),
  };
}
