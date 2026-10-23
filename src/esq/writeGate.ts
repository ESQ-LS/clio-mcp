/**
 * ESQ Legal Services - write-tool gate.
 *
 * ESQ fork modification. Not present upstream.
 *
 * Every Clio-mutating tool is withheld from registration unless it is named
 * in the ESQ_WRITE_TOOLS environment variable (comma-separated). With that
 * variable unset or empty, the server exposes read tools only.
 *
 * Document uploads enter through Clio, upstream of the Clio-managed OneDrive
 * `/Clio` tree and its one-way SharePoint mirror. They remain disabled unless
 * explicitly named here, like every other production write tool.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Every tool that mutates Clio state. Auth tools (`authenticate`, `logout`)
 * are excluded: they touch only the local token store, not Clio.
 */
const WRITE_TOOLS = new Set<string>([
  "create_matter",
  "update_matter",
  "create_contact",
  "update_contact",
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
  "create_communication",
]);

function parseEnabled(): Set<string> {
  const raw = process.env.ESQ_WRITE_TOOLS ?? "";
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const enabled = new Set<string>();
  for (const name of names) {
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
