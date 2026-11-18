import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMiddleware } from "hono/factory";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { adminToken, agentTokens, AUTH_MIGRATIONS, callerOf } from "./auth.ts";
import type { Services } from "./contracts.ts";
import { openDb } from "./db.ts";
import { mcpServer } from "./mcp.ts";
import type { Context, Env, Instance, Module, Tool } from "./module.ts";

export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export interface AppOptions {
  /** The data folder; made (mode 700) if missing. */
  dir: string;
  modules: Module[];
  /** The built page (`dist/public`); without it only the API and /mcp are served. */
  publicDir?: string;
}

export interface App {
  fetch: (request: Request) => Response | Promise<Response>;
  ctx: Context;
  /** The person's token. */
  adminToken: string;
  close(): Promise<void>;
}

const CallerSchema = z
  .union([z.object({ kind: z.literal("person") }), z.object({ kind: z.literal("agent"), agentId: z.string() })])
  .openapi("Caller");
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Check health",
  description: "Answers without a token, so a supervisor can tell the app is up.",
  responses: { 200: { description: "Up.", content: { "application/json": { schema: z.object({ ok: z.literal(true), version: z.string() }) } } } },
});
const meRoute = createRoute({
  method: "get",
  path: "/api/me",
  summary: "Who am I",
  description: "Who the token is: the person (the admin token) or an agent (its own token).",
  security: [{ bearer: [] }],
  responses: {
    200: { description: "The caller.", content: { "application/json": { schema: CallerSchema } } },
    401: { description: "No token, or one this app did not issue.", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export function createApp(options: AppOptions): App {
  const dir = resolve(options.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  const admin = adminToken(dir);

  const migrations: Record<string, string[]> = { core: AUTH_MIGRATIONS };
  for (const m of options.modules) {
    if (m.name === "core" || migrations[m.name]) throw new Error(`two modules are named ${m.name}`);
    migrations[m.name] = m.migrations;
  }
  const db = openDb(join(dir, "workplace.db"), migrations);
  const tokens = agentTokens(db);
  const services = {} as Services;
  const ctx: Context = { dir, agentsDir, db, tokens, services };

  const instances = options.modules.map((m) => [m, m.create(ctx)] as [Module, Instance]);
  for (const [m, inst] of instances) {
    if (inst.service) (services as unknown as Record<string, unknown>)[m.name] = inst.service;
  }
  const tools: Tool[] = instances.flatMap(([, inst]) => inst.tools ?? []);
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`two tools are named ${t.name}`);
    seen.add(t.name);
  }

  const app = new OpenAPIHono<Env>();
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer" });

  app.openapi(healthRoute, (c) => c.json({ ok: true as const, version: VERSION }));
  app.get("/api/docs", (c) =>
    c.json({
      ...app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "agent-workplace",
          version: VERSION,
          description:
            "The person's page and their agents use this API to work with tasks, the queue, agents, roles and skills. Send `Authorization: Bearer <token>`: the admin token for the person, an agent's own token for that agent. The same work is served as MCP tools at `/mcp`, listed under `x-mcp-tools`.",
        },
      }),
      "x-mcp-tools": tools.map((t) => ({ name: t.name, title: t.title, description: t.description })),
    }),
  );

  const signedIn = createMiddleware<Env>(async (c, next) => {
    const caller = callerOf(c.req.header("Authorization"), admin, tokens.agentOf);
    if (!caller) {
      c.header("WWW-Authenticate", 'Bearer realm="agent-workplace"');
      return c.json({ error: "send Authorization: Bearer <token>: the admin token, or an agent's own" }, 401);
    }
    c.set("caller", caller);
    await next();
  });
  app.use("/api/*", async (c, next) => (c.req.path === "/api/docs" ? next() : signedIn(c, next)));
  app.use("/mcp", signedIn);

  app.openapi(meRoute, (c) => c.json(c.get("caller"), 200));
  for (const [m, inst] of instances) {
    if (!inst.routes) continue;
    const api = new OpenAPIHono<Env>();
    inst.routes(api);
    app.route(`/api/${m.name}`, api);
  }
  app.all("/api/*", (c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404));

  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcpServer(tools, VERSION, c.get("caller")).connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  if (options.publicDir) {
    const root = resolve(options.publicDir);
    const file = (path: string) => {
      const full = normalize(join(root, decodeURIComponent(path)));
      if (full !== root && !full.startsWith(root + sep)) return undefined;
      try {
        return statSync(full).isFile() ? full : undefined;
      } catch {
        return undefined;
      }
    };
    app.get("*", (c) => {
      // Any path that is not a file is one of the page's own routes (/work, /items/<id>, …): serve the shell.
      const found = file(c.req.path) ?? file("index.html");
      if (!found) return c.text("the page is not built: run npm run build", 404);
      c.header("Content-Type", TYPES[extname(found)] ?? "application/octet-stream");
      return c.body(readFileSync(found));
    });
  }

  return {
    fetch: (request) => app.fetch(request),
    ctx,
    adminToken: admin,
    async close() {
      for (const [, inst] of instances.reverse()) await inst.close?.();
      db.close();
    },
  };
}
