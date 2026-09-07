/**
 * MCP annotations for bounded lookups that do not change Clio or auth state.
 * Under ChatGPT's annotation semantics, these reads stay inside the current
 * user's authenticated Clio account, so they do not reach an open world.
 */
export const CLIO_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** MCP annotations for read-only tools that inspect only local connector data. */
export const LOCAL_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Starts an external OAuth flow and may add or replace local auth state. */
export const AUTHENTICATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Clears local authentication state. */
export const LOGOUT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** A production-capable create is additive but interacts with Clio. */
export const CLIO_CREATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** A production-capable update can replace existing Clio record fields. */
export const CLIO_UPDATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** A controlled time-entry update modifies fields without deleting the record. */
export const CLIO_CONTROLLED_UPDATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
