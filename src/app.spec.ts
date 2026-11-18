import { z } from "@hono/zod-openapi";
import { createRoute } from "@hono/zod-openapi";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.ts";
import { tool, type Module } from "./module.ts";
import { modules } from "./modules.ts";

const fake: Module = {
  name: "fake",
  migrations: ["CREATE TABLE fake_things (id TEXT PRIMARY KEY)"],
  create: () => ({
    routes(api) {
      api.openapi(
        createRoute({ method: "get", path: "/ping", summary: "Ping fake", responses: { 200: { description: "Pong.", content: { "application/json": { schema: z.object({ pong: z.boolean() }) } } } } }),
        (c) => c.json({ pong: true }),
      );
    },
    tools: [tool({ name: "who_am_i", title: "Who am I", description: "The caller.", input: { shout: z.boolean().optional() }, readOnly: true, run: (_args, caller) => caller })],
  }),
};

let dirs: string[] = [];
let apps: App[] = [];
const start = (dir = mkdtempSync(join(tmpdir(), "awp-")), mods: Module[] = [...modules, fake]) => {
  dirs.push(dir);
  const app = createApp({ dir, modules: mods });
  apps.push(app);
  return app;
};
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  apps = [];
  dirs = [];
});
const get = (app: App, path: string, token?: string) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));

describe("the app", () => {
  it("makes its data folder, database, agents folder and a mode-600 admin token that lasts across restarts", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "awp-")), "data");
    const first = start(dir);
    expect(existsSync(join(dir, "workplace.db"))).toBe(true);
    expect(existsSync(join(dir, "agents"))).toBe(true);
    expect(statSync(join(dir, "admin-token")).mode & 0o777).toBe(0o600);
    const token = first.adminToken;
    await first.close();
    apps = [];
    const second = start(dir);
    expect(second.adminToken).toBe(token);
  });

  it("answers /health without a token", async () => {
    const res = await get(start(), "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("refuses the API and /mcp without a token or with one it did not issue", async () => {
    const app = start();
    for (const path of ["/api/me", "/api/fake/ping", "/api/nothing", "/mcp"]) {
      expect((await get(app, path)).status).toBe(401);
      expect((await get(app, path, "awp_not-a-real-token")).status).toBe(401);
    }
  });

  it("tells the admin token from an agent's, and a revoked agent token no longer works", async () => {
    const app = start();
    expect(await (await get(app, "/api/me", app.adminToken)).json()).toEqual({ kind: "person" });
    const agentToken = app.ctx.tokens.issue("agent-1");
    expect(await (await get(app, "/api/me", agentToken)).json()).toEqual({ kind: "agent", agentId: "agent-1" });
    app.ctx.tokens.revoke("agent-1");
    expect((await get(app, "/api/me", agentToken)).status).toBe(401);
  });

  it("mounts each module's routes under /api/<module>/ and lists them, and every tool, in /api/docs", async () => {
    const app = start();
    expect(await (await get(app, "/api/fake/ping", app.adminToken)).json()).toEqual({ pong: true });
    const docs = (await (await get(app, "/api/docs")).json()) as { paths: Record<string, unknown>; "x-mcp-tools": { name: string }[] };
    expect(Object.keys(docs.paths)).toEqual(expect.arrayContaining(["/health", "/api/me", "/api/fake/ping"]));
    expect(docs["x-mcp-tools"].map((t) => t.name)).toEqual(["who_am_i"]);
  });

  it("serves every module's tools on one /mcp, each run as its caller", async () => {
    const app = start();
    const agentToken = app.ctx.tokens.issue("agent-2");
    for (const [token, caller] of [[app.adminToken, { kind: "person" }], [agentToken, { kind: "agent", agentId: "agent-2" }]] as const) {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: async (input, init) => app.fetch(new Request(input, init)),
        }),
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["who_am_i"]);
      const result = (await client.callTool({ name: "who_am_i", arguments: {} })) as { content: { text: string }[] };
      expect(JSON.parse(result.content[0]!.text)).toEqual(caller);
      await client.close();
    }
  });

  it("lists no tools, rather than failing, when no module has any", async () => {
    const app = start(undefined, modules);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${app.adminToken}` } },
        fetch: async (input, init) => app.fetch(new Request(input, init)),
      }),
    );
    expect((await client.listTools()).tools).toEqual([]);
    await client.close();
  });

  it("applies each module's migrations once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awp-"));
    await start(dir).close();
    apps = [];
    const app = start(dir);
    const rows = app.ctx.db.prepare("SELECT module, version FROM migrations ORDER BY module").all();
    expect(rows).toEqual([{ module: "core", version: 1 }, { module: "fake", version: 1 }]);
  });

  it("registers the tasks, skills, roles, agents and queue modules, and gives every service in contracts.ts", async () => {
    expect(modules.map((m) => m.name)).toEqual(["tasks", "skills", "roles", "agents", "queue"]);
    const app = start(undefined, modules);
    expect(Object.keys(app.ctx.services).sort()).toEqual(["agents", "roles", "skills", "tasks"]);
    expect(await app.ctx.services.roles.list()).toEqual([]);
  });
});
