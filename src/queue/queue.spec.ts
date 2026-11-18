import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type App } from "../app.ts";
import type { Agent, AgentEvent, Agents, NewAgent } from "../contracts.ts";
import type { Module } from "../module.ts";
import { tasks } from "../tasks/index.ts";
import { queueModule } from "./index.ts";

// A stand-in for the agents module: no Claude runs. It records each agent made and, as the real one does, assigns the task.
function fakeAgents() {
  const made: NewAgent[] = [];
  const listeners = new Set<(e: AgentEvent) => void>();
  const module: Module = {
    name: "agents",
    migrations: [],
    create(ctx) {
      const service: Agents = {
        create: async (a) => {
          made.push(a);
          if (a.task) await ctx.services.tasks.update(a.task, { status: "in_progress", assignee: a.name }, { kind: "person" });
          return { id: `id-${a.name}`, name: a.name, task: a.task ?? null } as Agent;
        },
        get: async () => undefined,
        list: async () => [],
        send: async () => {},
        stop: async () => {},
        close: async () => {},
        delete: async () => {},
        onEvent: (l) => (listeners.add(l), () => listeners.delete(l)),
      };
      return { service };
    },
  };
  return { made, module, emit: (e: AgentEvent) => listeners.forEach((l) => l(e)) };
}

let dirs: string[] = [];
let apps: App[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

function start() {
  const dir = mkdtempSync(join(tmpdir(), "awp-queue-"));
  dirs.push(dir);
  const fake = fakeAgents();
  const app = createApp({ dir, modules: [tasks, fake.module, queueModule({ lookEveryMs: 3_600_000 })] });
  apps.push(app);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer ${app.adminToken}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  const task = async (title: string, extra: Record<string, unknown> = {}) => (await api("POST", "/api/tasks", { title, ...extra })).body.task as { id: string; shortId: string };
  const entry = async (id: string) => (await api("GET", "/api/queue")).body.entries.find((e: any) => e.taskId === id);
  return { app, fake, api, task, entry };
}

describe("queue", () => {
  it("holds a blocked task, says why, and starts it once its dependency closes", async () => {
    const { api, task, fake, entry } = start();
    const a = await task("first");
    const b = await task("second", { dependsOn: [a.id] });
    expect((await api("POST", "/api/queue", { taskId: b.id })).status).toBe(201);
    expect(fake.made).toHaveLength(0);
    expect((await entry(b.id)).note).toBe(`waits: blocked by ${a.shortId}`);
    expect((await entry(b.id)).state).toBe("queued");
    await api("POST", "/api/queue", { taskId: a.id });
    expect(fake.made.map((m) => m.name)).toEqual([`impl-${a.shortId}`]);
    expect(fake.made[0]).toMatchObject({ role: "implementer", task: a.id });
    expect(fake.made[0]!.brief).toContain(`Work on task ${a.shortId}: first`);
    expect(fake.made[0]!.brief).toContain("agent-workplace MCP server");
    expect(fake.made[0]!.brief).toContain("$AGENT_WORKPLACE_URL/api/tasks/");
    expect(fake.made[0]!.brief).not.toMatch(/waypoint|WAYPOINT|the person closes/i);
    // Still running: the second waits.
    await api("POST", "/api/queue/tick");
    expect(fake.made).toHaveLength(1);
    await api("PATCH", `/api/tasks/${a.id}`, { status: "done" });
    await vi.waitFor(() => expect(fake.made.map((m) => m.name)).toEqual([`impl-${a.shortId}`, `impl-${b.shortId}`]));
    await vi.waitFor(async () => expect((await entry(a.id)).state).toBe("finished"));
    expect((await entry(b.id)).state).toBe("started");
  });

  it("starts no more than the limit, and 0 pauses", async () => {
    const { api, task, fake, entry } = start();
    const ts = [await task("1"), await task("2"), await task("3")];
    for (const t of ts) await api("POST", "/api/queue", { taskId: t.id });
    expect(fake.made).toHaveLength(2);
    expect((await entry(ts[2]!.id)).note).toBe("waits: at the limit (2 running)");
    expect((await api("PUT", "/api/queue/limit", { limit: 3 })).body.limit).toBe(3);
    expect(fake.made).toHaveLength(3);
    const more = await task("4");
    await api("PUT", "/api/queue/limit", { limit: 0 });
    await api("POST", "/api/queue", { taskId: more.id });
    expect(fake.made).toHaveLength(3);
    expect((await entry(more.id)).note).toContain("paused");
    expect((await api("PUT", "/api/queue/limit", { limit: 51 })).status).toBe(400);
    await api("PUT", "/api/queue/limit", { limit: 4 });
    expect(fake.made).toHaveLength(4);
  });

  it("counts a task against the limit until it closes, not when its agent's session ends", async () => {
    const { api, task, fake } = start();
    const ts = [await task("1"), await task("2"), await task("3")];
    for (const t of ts) await api("POST", "/api/queue", { taskId: t.id });
    expect(fake.made).toHaveLength(2);
    fake.emit({ type: "ended", agentId: "x", reason: "ended" });
    await api("POST", "/api/queue/tick");
    expect(fake.made).toHaveLength(2); // the task is still open: it still counts
    await api("PATCH", `/api/tasks/${ts[0]!.id}`, { status: "cancelled" });
    await vi.waitFor(() => expect(fake.made).toHaveLength(3));
  });

  it("picks the agent's capability from metadata.difficulty, and waits on a bad one", async () => {
    const { api, task, fake, entry } = start();
    const hard = await task("hard", { metadata: { difficulty: 3 } });
    const plain = await task("plain");
    const bad = await task("bad", { metadata: { difficulty: 7 } });
    for (const t of [hard, plain, bad]) await api("POST", "/api/queue", { taskId: t.id });
    await api("PUT", "/api/queue/limit", { limit: 5 });
    expect(fake.made.find((m) => m.task === hard.id)!.capability).toBe(3);
    expect(fake.made.find((m) => m.task === plain.id)!.capability).toBeUndefined();
    expect(fake.made.find((m) => m.task === bad.id)).toBeUndefined();
    expect((await entry(bad.id)).note).toBe("waits: metadata.difficulty must be 1, 2 or 3");
  });

  it("keeps queue order, moves a task before another, and dequeues", async () => {
    const { api, task, fake } = start();
    await api("PUT", "/api/queue/limit", { limit: 0 });
    const [a, b, c] = [await task("a"), await task("b"), await task("c")] as { id: string }[];
    for (const t of [a!, b!]) await api("POST", "/api/queue", { taskId: t.id });
    await api("POST", "/api/queue", { taskId: c!.id, before: a!.id });
    expect((await api("GET", "/api/queue")).body.entries.map((e: any) => e.taskId)).toEqual([c!.id, a!.id, b!.id]);
    expect((await api("DELETE", `/api/queue/${a!.id}`)).status).toBe(200);
    expect((await api("DELETE", `/api/queue/${a!.id}`)).status).toBe(400);
    expect((await api("POST", "/api/queue", { taskId: b!.id, before: a!.id })).status).toBe(409);
    expect((await api("GET", "/api/queue")).body.entries.map((e: any) => e.taskId)).toEqual([c!.id, b!.id]);
    expect(fake.made).toHaveLength(0);
  });

  it("waits on an assigned task and refuses a closed one", async () => {
    const { api, task, entry } = start();
    const t = await task("mine", { assignee: "someone" });
    await api("POST", "/api/queue", { taskId: t.id });
    expect((await entry(t.id)).note).toBe("waits: assigned to someone");
    const done = await task("done", { status: "done" });
    expect((await api("POST", "/api/queue", { taskId: done.id })).status).toBe(409);
  });

  it("serves queue_task, dequeue_task, list_queue, set_limit and tick over /mcp", async () => {
    const { app, task, fake } = start();
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { requestInit: { headers: { Authorization: `Bearer ${app.adminToken}` } }, fetch: async (i, init) => app.fetch(new Request(i, init)) }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["queue_task", "dequeue_task", "list_queue", "set_limit", "tick"]) expect(names).toContain(n);
    const t = await task("via mcp");
    expect(await call("set_limit", { limit: 0 })).toEqual({ limit: 0 });
    const e = await call("queue_task", { taskId: t.shortId });
    expect(e).toMatchObject({ taskId: t.id, state: "queued", queuedBy: "person" });
    expect((await call("list_queue")).entries).toHaveLength(1);
    expect(fake.made).toHaveLength(0);
    await call("set_limit", { limit: 1 });
    expect((await call("tick")).entries[0].state).toBe("started");
    await expect(call("dequeue_task", { taskId: t.id })).rejects.toThrow("not queued");
    await client.close();
  });
});
