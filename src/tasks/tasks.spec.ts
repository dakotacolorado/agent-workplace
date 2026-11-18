import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.ts";
import type { TaskEvent } from "../contracts.ts";
import { modules } from "../modules.ts";

let dirs: string[] = [];
let apps: App[] = [];
const start = () => {
  const dir = mkdtempSync(join(tmpdir(), "awp-tasks-"));
  dirs.push(dir);
  const app = createApp({ dir, modules });
  apps.push(app);
  return app;
};
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

const api = (app: App, method: string, path: string, body?: unknown, token = app.adminToken) =>
  Promise.resolve(app
    .fetch(new Request(`http://localhost/api/tasks${path.replace(/^\/(\?|$)/, "$1")}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })))
    .then(async (r: Response) => ({ status: r.status, body: (await r.json()) as any }));

const make = async (app: App, fields: Record<string, unknown>) => { const r = await api(app, "POST", "/", fields); if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r.body.task; };

describe("tasks API", () => {
  it("creates, reads, lists with filters and updates tasks, labels and comments", async () => {
    const app = start();
    expect((await api(app, "POST", "/labels", { name: "Bug", color: "#ff0000" })).status).toBe(201);
    expect((await api(app, "POST", "/labels", { name: "bug" })).status).toBe(409);
    const a = await make(app, { title: "Fix it", description: "the Widget", labels: ["bug"], manager: "pm" });
    const b = await make(app, { title: "Other" });
    expect(a.shortId).toBe(a.id.slice(0, 8));
    expect((await api(app, "GET", `/${a.shortId}`)).body.task.title).toBe("Fix it");
    const ids = async (q: string) => (await api(app, "GET", `/${q}`)).body.tasks.map((t: any) => t.title);
    expect(await ids("")).toEqual(["Fix it", "Other"]);
    expect(await ids("?label=BUG")).toEqual(["Fix it"]);
    expect(await ids("?q=widget")).toEqual(["Fix it"]);
    expect(await ids("?manager=pm")).toEqual(["Fix it"]);
    expect(await ids("?manager=none")).toEqual(["Other"]);
    const upd = await api(app, "PATCH", `/${b.shortId}`, { assignee: "x", metadata: { k: 1 } });
    expect(upd.body.task).toMatchObject({ assignee: "x", metadata: { k: 1 } });
    expect(await ids("?assignee=x")).toEqual(["Other"]);
    expect((await api(app, "GET", "/zzzzzzzz")).status).toBe(404);
    expect((await api(app, "GET", `/${a.id}/history`)).body.entries.map((e: any) => e.action)).toEqual(["created"]);
    expect((await api(app, "GET", "/labels")).body.labels).toHaveLength(1);
  });

  it("refuses leaving backlog with an open dependency and done with an unmet criterion or open subtask", async () => {
    const app = start();
    const a = await make(app, { title: "a" });
    const b = await make(app, { title: "b", dependsOn: [a.shortId], criteria: [{ text: "c" }], subtasks: [{ title: "s" }] });
    expect(b.blockedBy).toEqual([a.id]);
    expect(b.ready).toBe(false);
    const blocked = await api(app, "PATCH", `/${b.id}`, { status: "in_progress" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockedBy).toEqual([a.id]);
    expect((await api(app, "PATCH", `/${a.id}`, { status: "done" })).status).toBe(200);
    expect((await api(app, "GET", `/${b.id}`)).body.task.ready).toBe(true);
    expect((await api(app, "PATCH", `/${b.id}`, { status: "in_progress" })).status).toBe(200);
    const unmet = await api(app, "PATCH", `/${b.id}`, { status: "done" });
    expect(unmet.status).toBe(409);
    expect(unmet.body.unmetCriteria).toEqual(["c1"]);
    await api(app, "PATCH", `/${b.id}`, { criteria: [{ id: "c1", met: true }] });
    const open = await api(app, "PATCH", `/${b.id}`, { status: "done" });
    expect(open.status).toBe(409);
    expect(open.body.openSubtasks).toEqual(["s1"]);
    await api(app, "PATCH", `/${b.id}`, { subtasks: [{ id: "s1", status: "done" }] });
    expect((await api(app, "PATCH", `/${b.id}`, { status: "done" })).body.task.status).toBe("done");
  });

  it("updates criteria and subtasks as whole lists, and refuses dependency cycles", async () => {
    const app = start();
    const a = await make(app, { title: "a", criteria: [{ text: "one" }, { text: "two" }], subtasks: [{ title: "x" }, { title: "y" }] });
    const r = await api(app, "PATCH", `/${a.id}`, { criteria: [{ id: "c2", met: true }], subtasks: [{ id: "s2" }] });
    expect(r.body.task.criteria).toMatchObject([{ id: "c2", text: "two", met: true }]);
    expect(r.body.task.subtasks.map((s: any) => s.id)).toEqual(["s2"]);
    const b = await make(app, { title: "b", dependsOn: [a.id] });
    const cyc = await api(app, "PATCH", `/${a.id}`, { dependsOn: [b.id] });
    expect(cyc.status).toBe(400);
    expect(cyc.body.error).toMatch(/cycle/);
  });

  it("returns the first task for a repeated clientToken", async () => {
    const app = start();
    const one = await make(app, { title: "a", clientToken: "t1" });
    const two = await make(app, { title: "different", clientToken: "t1" });
    expect(two.id).toBe(one.id);
    expect((await api(app, "GET", "/")).body.tasks).toHaveLength(1);
  });

  it("filters ready to unassigned backlog tasks with nothing blocking, and comments carry the caller", async () => {
    const app = start();
    const a = await make(app, { title: "a" });
    await make(app, { title: "b", dependsOn: [a.id] });
    await make(app, { title: "c", assignee: "someone" });
    const ready = async () => (await api(app, "GET", "/?ready=true")).body.tasks.map((t: any) => t.title);
    expect(await ready()).toEqual(["a"]);
    await api(app, "PATCH", `/${a.id}`, { status: "cancelled" });
    expect(await ready()).toEqual(["b"]);
    const agentToken = app.ctx.tokens.issue("agent-9");
    const c = await api(app, "POST", `/${a.id}/comments`, { body: "hi" }, agentToken);
    expect(c.body.comment.author).toBe("agent-9");
    const p = await api(app, "POST", `/${a.id}/comments`, { body: "yo" });
    expect(p.body.comment.author).toBe("person");
    expect((await api(app, "GET", `/${a.id}/comments`)).body.comments.map((x: any) => x.body)).toEqual(["hi", "yo"]);
  });

  it("serves the Tasks interface and emits an event once when a task closes", async () => {
    const app = start();
    const tasks = app.ctx.services.tasks;
    const events: TaskEvent[] = [];
    tasks.onEvent((e) => events.push(e));
    const a = await make(app, { title: "a" });
    expect((await tasks.get(a.shortId))?.id).toBe(a.id);
    expect((await tasks.listReady()).map((t) => t.id)).toEqual([a.id]);
    await tasks.update(a.id, { status: "in_progress", assignee: "me" }, { kind: "person" });
    expect(events).toEqual([]);
    expect(await tasks.listReady()).toEqual([]);
    await tasks.update(a.id, { status: "done" }, { kind: "person" });
    await tasks.update(a.id, { assignee: "you" }, { kind: "person" });
    expect(events).toEqual([{ type: "closed", taskId: a.id, status: "done" }]);
    await expect(tasks.update("nonexistent", {}, { kind: "person" })).rejects.toThrow();
    expect((await tasks.comment(a.id, "note", { kind: "person" })).author).toBe("person");
  });
});

describe("tasks MCP tools", () => {
  it("serve waypoint's tool names and create two tasks where the dependent is ready only once the first is done", async () => {
    const app = start();
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch: async (u, i) => app.fetch(new Request(u as string, i)), requestInit: { headers: { Authorization: `Bearer ${app.adminToken}` } } }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["create_task", "get_task", "list_tasks", "update_task", "create_comment", "list_comments", "create_label", "list_labels"]) expect(names).toContain(n);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as any;
      if (name !== "update_task" && r.isError) throw new Error(r.content[0].text);
      return { error: r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
    };
    const first = (await call("create_task", { title: "first" })).data.task;
    const second = (await call("create_task", { title: "second", dependsOn: [first.shortId] })).data.task;
    const readyTitles = async () => (await call("list_tasks", { ready: true })).data.tasks.map((t: any) => t.title);
    expect((await call("get_task", { taskId: second.shortId })).data.task.ready).toBe(false);
    expect(await readyTitles()).toEqual(["first"]);
    expect((await call("update_task", { taskId: second.id, status: "in_progress" })).error).toBe(true);
    await call("update_task", { taskId: first.id, status: "done" });
    expect((await call("get_task", { taskId: second.shortId })).data.task.ready).toBe(true);
    expect(await readyTitles()).toEqual(["second"]);
    await call("create_label", { name: "x" });
    expect((await call("list_labels", {})).data.labels).toHaveLength(1);
    await call("create_comment", { taskId: first.id, body: "hello" });
    expect((await call("list_comments", { taskId: first.id })).data.comments[0].body).toBe("hello");
    await client.close();
  });
});
