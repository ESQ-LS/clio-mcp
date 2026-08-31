/**
 * MCP annotations for tools that retrieve data from Clio without changing it.
 *
 * Clio is an external system, so openWorldHint remains true even though these
 * tools are non-destructive reads.
 */
export const CLIO_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/** MCP annotations for read-only tools that inspect only local connector data. */
export const LOCAL_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
