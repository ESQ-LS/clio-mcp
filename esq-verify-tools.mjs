// ESQ: lists the tools the server actually advertises over stdio.
// Usage: ESQ_WRITE_TOOLS="..." node esq-verify-tools.mjs
import { spawn } from "node:child_process";

const child = spawn("node", ["build/index.js"], {
  env: {
    ...process.env,
    TRANSPORT: "stdio",
    CLIO_CLIENT_ID: "verify-only",
    CLIO_CLIENT_SECRET: "verify-only",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      console.log("ADVERTISED (" + names.length + "): " + names.join(", "));
      child.kill();
      process.exit(0);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2024-11-05", capabilities: {},
  clientInfo: { name: "esq-verify", version: "1" } } });
setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
}, 600);
setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 12000);
