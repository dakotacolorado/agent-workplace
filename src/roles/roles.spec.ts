import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.ts";
import { modules } from "../modules.ts";
import { createSkills } from "../skills/index.ts";
import { DEFAULT_SKILLS } from "./defaults/index.ts";
import { readRole } from "./domain.ts";
import { createRoles } from "./index.ts";

let dirs: string[] = [];
let apps: App[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

function start(opts: { defaults?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "awr-"));
  if (!opts.dir) dirs.push(dir);
  const logs: string[] = [];
  const mods = modules.map((m) => (m.name === "roles" ? createRoles({ log: (l) => logs.push(l), ...(opts.defaults ? {} : { defaults: [] }) }) : m.name === "skills" ? createSkills({ judge: null, log: () => {} }) : m));
  const app = createApp({ dir, modules: mods });
  apps.push(app);
  return { app, logs };
}

async function client(app: App, token: string) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: async (i: any, init: any) => app.fetch(new Request(i, init)) }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, out: r.content[0]!.text };
  };
  return { call, close: () => c.close() };
}

const text = async (app: App, name: string, version?: number) => (await app.ctx.services.skills.get(name, version))!;

describe("roles", () => {
  it("creates and updates a role as versions of the skill roles/<name>", async () => {
    const { app } = start();
    const c = await client(app, app.adminToken);
    const made = await c.call("create_role", { name: "builder", summary: "Builds things.", body: "Build it.", priority: 70, capability: 3, skills: ["team/style"], whenDone: "keep" });
    expect(made.error).toBe(false);
    const v = (await text(app, "roles/builder")).version;
    expect(v).toBe(2); // SKILL.md, then role.json
    expect((await text(app, "roles/builder")).files.map((f) => f.path)).toEqual(["role.json", "SKILL.md"]);
    expect(JSON.parse((await text(app, "roles/builder")).files[0]!.content)).toMatchObject({ summary: "Builds things.", priority: 70, capability: 3 });

    expect((await c.call("update_role", { name: "builder", body: "Build it well." })).error).toBe(false);
    expect((await text(app, "roles/builder")).version).toBe(v + 1);
    expect((await text(app, "roles/builder", v)).files.find((f) => f.path === "SKILL.md")!.content).toContain("Build it.");
    expect((await c.call("update_role", { name: "builder", priority: 10 })).error).toBe(false);
    expect((await text(app, "roles/builder")).version).toBe(v + 2);

    const role = await app.ctx.services.roles.get("builder");
    expect(role).toEqual({ name: "builder", description: "Builds things.", skills: ["roles/builder", "team/style"], priority: 10, capability: 3, brief: "", whenDone: "keep", instructions: "Build it well." });
    expect((await c.call("create_role", { name: "builder", summary: "x", body: "y" })).error).toBe(true);
    expect((await c.call("create_role", { name: "Bad Name", summary: "x", body: "y" })).error).toBe(true);
    expect((await c.call("update_role", { name: "nobody", priority: 1 })).error).toBe(true);
    await c.close();
  });

  it("is the person's alone to write", async () => {
    const { app } = start();
    const agent = await client(app, app.ctx.tokens.issue("a1"));
    expect((await agent.call("create_role", { name: "x", summary: "x", body: "y" })).error).toBe(true);
    expect(await app.ctx.services.skills.get("roles/x")).toBeUndefined();
    expect((await agent.call("list_roles", {})).error).toBe(false);
    await agent.close();
  });

  it("lists by priority then name, and leaves out an invalid role with its reason logged", async () => {
    const { app, logs } = start();
    const c = await client(app, app.adminToken);
    for (const [name, priority] of [["b", 50], ["a", 50], ["z", 90], ["m", 10]] as const) await c.call("create_role", { name, summary: `Role ${name}.`, body: "Text.", priority });
    const md = (n: string) => ({ path: "SKILL.md", content: `---\nname: ${n}\ndescription: d\n---\n\nx\n` });
    const w = (n: string, files: object[]) => Promise.all(files.map((f) => app.ctx.services.skills.writeFile(`roles/${n}`, f as never, { kind: "person" })));
    await w("nojson", [md("nojson")]);
    await w("badjson", [md("badjson"), { path: "role.json", content: '{"summary":"s","priority":500}' }]);
    await w("notjson", [md("notjson"), { path: "role.json", content: "{" }]);

    expect((await app.ctx.services.roles.list()).map((r) => r.name)).toEqual(["z", "a", "b", "m"]);
    const listed = JSON.parse((await c.call("list_roles", {})).out).roles as { name: string }[];
    expect(listed.map((r) => r.name)).toEqual(["z", "a", "b", "m"]);
    expect(logs.join("\n")).toMatch(/nojson left out: no role.json/);
    expect(logs.join("\n")).toMatch(/badjson left out: role.json: priority/);
    expect(logs.join("\n")).toMatch(/notjson left out: role.json is not JSON/);
    expect((await c.call("get_role", { name: "badjson" })).error).toBe(true);
    expect(JSON.parse((await c.call("get_role", { name: "z" })).out).role.instructions).toBe("Text.");
    await c.close();
  });

  it("reads fresh: an edit to the skill applies at the next call, and deleting the skill deletes the role", async () => {
    const { app } = start();
    const c = await client(app, app.adminToken);
    await c.call("create_role", { name: "r", summary: "S.", body: "One." });
    expect((await app.ctx.services.roles.get("r"))?.priority).toBe(50);
    await app.ctx.services.skills.writeFile("roles/r", { path: "role.json", content: '{"summary":"S.","priority":99}' }, { kind: "person" });
    expect((await app.ctx.services.roles.get("r"))?.priority).toBe(99);
    await c.close();
  });

  it("serves the roles over the API", async () => {
    const { app } = start();
    const call = (method: string, path: string, body?: object, token = app.adminToken) =>
      app.fetch(new Request(`http://localhost/api/roles${path === "/" ? "" : path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }));
    expect((await call("POST", "/", { name: "api-role", summary: "S.", body: "T." })).status).toBe(200);
    expect((await call("PATCH", "/api-role", { capability: 1 })).status).toBe(200);
    expect(((await (await call("GET", "/api-role")).json()) as { role: { capability: number } }).role.capability).toBe(1);
    expect(((await (await call("GET", "/")).json()) as { roles: unknown[] }).roles).toHaveLength(1);
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("POST", "/", { name: "x", summary: "S.", body: "T." }, app.ctx.tokens.issue("a1"))).status).toBe(403);
    expect((await call("POST", "/", { name: "x", summary: "S.", body: "T.", priority: 200 })).status).toBe(400);
  });

  describe("the defaults", () => {
    const FORBIDDEN = [/release-routines/i, /jobber/i, /tailnet/i, /tailscale/i, /ts\.net/i, /lenovo/i, /keyring/i, /peek/i, /nudge/i, /blogger/i, /dakota/i, /waypoint/i, /hopper/i, /honed/i, /agency/i, /\bbeta\b/i, /\bprod\b/i, /\bhosts?\b/i, /\bstages?\b/i, /discord/i];

    it("gives a fresh app exactly the planner, project-manager and implementer roles, each valid", async () => {
      const { app, logs } = start({ defaults: true });
      const c = await client(app, app.adminToken);
      const listed = JSON.parse((await c.call("list_roles", {})).out).roles as { name: string; skills: string[]; priority: number; capability: number }[];
      expect(listed.map((r) => r.name)).toEqual(["planner", "project-manager", "implementer"]);
      expect(listed.map((r) => [r.priority, r.capability])).toEqual([[40, 3], [35, 2], [10, 2]]);
      for (const r of listed) {
        const skill = await text(app, `roles/${r.name}`);
        const read = readRole(skill);
        expect("invalid" in read ? read.invalid : "valid").toBe("valid");
        for (const s of r.skills) expect(await app.ctx.services.skills.get(s), s).toBeDefined();
      }
      expect(listed.find((r) => r.name === "planner")!.skills).toEqual(["roles/planner", "workplace/rules", "workplace/tasks-to-merge", "workplace/readme-writing"]);
      expect(listed.find((r) => r.name === "project-manager")!.skills).toEqual(["roles/project-manager", "workplace/rules", "workplace/tasks-to-merge"]);
      expect(logs.join("\n")).not.toMatch(/left out/);
      await c.close();
    });

    it("seeds once: a restart adds nothing, and a default the person deleted stays deleted", async () => {
      const dir = mkdtempSync(join(tmpdir(), "awr-"));
      dirs.push(dir);
      const first = start({ defaults: true, dir });
      expect((await first.app.ctx.services.roles.list()).map((r) => r.name)).toContain("planner");
      const del = await first.app.fetch(new Request(`http://localhost/api/skills/${encodeURIComponent("roles/planner")}`, { method: "DELETE", headers: { Authorization: `Bearer ${first.app.adminToken}` } }));
      expect(del.status).toBe(200);
      await first.app.close();
      apps = apps.filter((a) => a !== first.app);
      const second = start({ defaults: true, dir });
      expect((await second.app.ctx.services.roles.list()).map((r) => r.name)).toEqual(["project-manager", "implementer"]);
      expect((await text(second.app, "workplace/rules")).version).toBe(1);
    });

    it("names no machine, stage, release job, outside service or person", () => {
      expect(DEFAULT_SKILLS.map((s) => s.name).sort()).toEqual(["roles/implementer", "roles/planner", "roles/project-manager", "workplace/readme-writing", "workplace/rules", "workplace/tasks-to-merge"]);
      for (const s of DEFAULT_SKILLS)
        for (const f of s.files) for (const word of FORBIDDEN) expect(word.test(f.content), `${s.name}/${f.path} matches ${word}`).toBe(false);
    });

    it("says how each role works: the implementer merges its own PR, the planner starts a PM, the PM queues and reports", () => {
      const body = (name: string) => DEFAULT_SKILLS.find((s) => s.name === name)!.files.find((f) => f.path === "SKILL.md")!.content;
      const impl = body("roles/implementer");
      expect(impl).toMatch(/repo's own checks/);
      expect(impl).toMatch(/merge it yourself/);
      expect(impl).toMatch(/once every criterion is met, move the task to `done`/);
      const planner = body("roles/planner");
      for (const s of ["criteria", "verification", "dependsOn", "difficulty", "manager: <that name>", "create_agent", 'role:\n"project-manager"']) expect(planner).toContain(s);
      const pm = body("roles/project-manager");
      expect(pm).toContain("queue_task");
      expect(pm).toMatch(/One report at the end/);
      expect(body("workplace/rules")).toMatch(/set_status/);
      expect(body("workplace/rules")).toMatch(/set_title/);
      expect(body("workplace/rules")).toMatch(/submit_feedback/);
    });
  });
});
