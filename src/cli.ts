#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { modules } from "./modules.ts";

const dir = process.env.AGENT_WORKPLACE_DIR || join(homedir(), ".agent-workplace");
const port = Number(process.env.AGENT_WORKPLACE_PORT || 4747);
const publicDir = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/public/" : "./public/", import.meta.url));

const app = createApp({ dir, modules, publicDir });
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`agent-workplace is running, its data in ${dir}`);
  console.log(`Open it signed in: http://localhost:${info.port}/#signin=${app.adminToken}`);
});
server.on("error", (err) => {
  console.error(`agent-workplace could not start: ${err.message}`);
  process.exit(1);
});

const shutdown = () => {
  server.close();
  void app.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
