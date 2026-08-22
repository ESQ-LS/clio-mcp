/**
 * ESQ Legal Services - write-tool gate.
 *
 * ESQ fork modification. Not present upstream.
 *
 * Every Clio-mutating tool is withheld from registration unless it is named
 * in the ESQ_WRITE_TOOLS environment variable (comma-separated). With that
 * variable unset or empty, the server exposes read tools only.
 *
 * `upload_document` is blocked unconditionally and cannot be re-enabled via
 * configuration. Clio documents are populated from the Clio Drive tree and
 * mirrored one-way into SharePoint; a second write path into Clio documents
 * produces orphaned files with no counterpart in the mirror. If the SharePoint
 * mirror is ever retired, remove the entry from PERMANENTLY_BLOCKED below --
 * deliberately a code change, not a config change.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Cannot be enabled by configuration. Requires a code change. */
const PERMANENTLY_BLOCKED = new Set<string>(["upload_document"]);

/**
 * Every tool that mutates Clio state. Auth tools (`authenticate`, `logout`)
 * are excluded: they touch only the local token store, not Clio.
 */
const WRITE_TOOLS = new Set<string>([
  "create_matter",
  "upload_document",
  "create_calendar_entry",
  "log_time_entry",
  "create_activity",
  "create_time_entry",
  "update_time_entry",
  "create_task",
  "update_task",
  "complete_task",
  "create_note",
]);

function parseEnabled(): Set<string> {
  const raw = process.env.ESQ_WRITE_TOOLS ?? "";
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const enabled = new Set<string>();
  for (const name of names) {
    if (PERMANENTLY_BLOCKED.has(name)) {
      console.error(
        `[esq] ESQ_WRITE_TOOLS lists "${name}", which is permanently blocked in this fork. Ignoring.`,
      );
      continue;
    }
    if (!WRITE_TOOLS.has(name)) {
      console.error(
        `[esq] ESQ_WRITE_TOOLS lists "${name}", which is not a known write tool. Ignoring.`,
      );
      continue;
    }
    enabled.add(name);
  }
  return enabled;
}

/**
 * Wraps `server.registerTool` so that disabled write tools are never
 * registered. A tool that is not registered is not advertised to the client
 * and cannot be invoked -- this is refusal at the registration layer, not a
 * runtime check inside the handler.
 *
 * Call once, immediately after constructing the McpServer and before any
 * register*Tools() call.
 */
export function applyWriteGate(server: McpServer): void {
  const enabled = parseEnabled();
  const original = server.registerTool.bind(server);
  const withheld: string[] = [];

  (server as unknown as Record<string, unknown>).registerTool = (
    name: string,
    ...rest: unknown[]
  ) => {
    if (WRITE_TOOLS.has(name) && !enabled.has(name)) {
      withheld.push(name);
      return undefined;
    }
    return (original as (...args: unknown[]) => unknown)(name, ...rest);
  };

  process.nextTick(() => {
    const on = enabled.size > 0 ? [...enabled].join(", ") : "none (read-only)";
    console.error(`[esq] write tools enabled: ${on}`);
    if (withheld.length > 0) {
      console.error(`[esq] write tools withheld: ${withheld.join(", ")}`);
    }
  });
}
