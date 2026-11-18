import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type App } from "../app.ts";
import type { AgentEvent, Role, Skill, Skills } from "../contracts.ts";
import type { Module } from "../module.ts";
import { queue } from "../queue/index.ts";
import { tasks } from "../tasks/index.ts";
import * as claude from "./claude.ts";
import { agentsModule, type AgentsModuleOptions } from "./index.ts";
import { Inbox, type SessionHandle, type SessionOptions, type StartSession } from "./runner.ts";
import { RESUME_TEXT, SILENT, type AgentService } from "./service.ts";

// --- a stand-in for Claude Code: no test here, or anywhere, calls Claude --------

class FakeSession {
  readonly sent: string[] = [];
  closed = false;
  private readonly out = new Inbox<unknown>();
  private failure: Error | null = null;
  readonly handle: SessionHandle;
  readonly options: SessionOptions;

  constructor(options: SessionOptions) {
    this.options = options;
    const self = this;
    this.handle = {
      send: (text) => this.sent.push(text),
      close: () => {
        this.closed = true;
        this.out.close();
      },
      events: {
        async *[Symbol.asyncIterator]() {
          for await (const m of self.out) yield m;
          if (self.failure) throw self.failure;
        },
      },
    };
  }

  say(...messages: unknown[]): void {
    for (const m of messages) this.out.push(m);
  }

  fail(message: string): void {
    this.failure = new Error(message);
    this.out.close();
  }
}

function fakeClaude() {
  const sessions: FakeSession[] = [];
  const start: StartSession = (o) => {
    const s = new FakeSession(o);
    sessions.push(s);
    return s.handle;
  };
  return { sessions, start };
}

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId });
const text = (t: string) => ({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: t }] } });
const toolUse = (name: string, input: unknown) => ({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name, input }] } });
const toolResult = (t: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: t }] } });
const result = (input = 1000, output = 100) => ({
  type: "result",
  subtype: "success",
  model_usage_since_last_result: { "claude-opus-5-5": { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
});

// --- roles and skills as their modules will give them ------------------------------

const ROLES: Role[] = [
  { name: "implementer", description: "Does one task.", skills: ["implementer", "team/testing"], priority: 1, capability: 2, brief: "Ship the task you are given." },
  { name: "planner", description: "Plans.", skills: [], priority: 5, capability: 3, brief: "" },
];
const skill = (name: string, body: string): Skill => ({
  name,
  description: name,
  version: 2,
  files: [
    { path: "SKILL.md", content: `---\nname: ${name}\ndescription: x\n---\n\n${body}\n` },
    { path: "bin/run", content: "#!/bin/sh\n", executable: true },
  ],
  updatedAt: "2026-11-18T00:00:00.000Z",
});
const SKILLS = [skill("implementer", "# Doing one task\n\nFirst the implementer's rule."), skill("team/testing", "# Testing\n\nThen the testing rule.")];

const fakeRoles: Module = { name: "roles", migrations: [], create: () => ({ service: { list: async () => ROLES, get: async (n: string) => ROLES.find((r) => r.name === n) } }) };
const fakeSkills: Module = {
  name: "skills",
  migrations: [],
  create: () => ({
    service: {
      get: async (n: string) => SKILLS.find((s) => s.name === n),
      list: async () => SKILLS,
      writeFile: async () => {
        throw new Error("no");
      },
      submitFeedback: async () => ({ id: "x" }),
      seed: async () => [],
    } satisfies Skills,
  }),
};

// --- the app under test ------------------------------------------------------------

let dirs: string[] = [];
let apps: App[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

function start(options: AgentsModuleOptions = {}, dir = mkdtempSync(join(tmpdir(), "awp-agents-"))) {
  dirs.push(dir);
  const fake = fakeClaude();
  const app = createApp({
    dir,
    modules: [tasks, fakeSkills, fakeRoles, agentsModule({ startSession: fake.start, url: "http://127.0.0.1:4799", env: { HOME: "/home/someone", PATH: "/bin", CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "/home/someone/.claude-login" }, ...options }), queue],
  });
  apps.push(app);
  const svc = app.ctx.services.agents as AgentService;
  const events: AgentEvent[] = [];
  svc.onEvent((e) => events.push(e));
  return { app, svc, fake, events, dir };
}

const api = (app: App, method: string, path: string, token: string, body?: unknown) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );

async function mcp(app: App, token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  );
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    },
    close: () => client.close(),
  };
}

const tokenOf = (s: FakeSession) => s.options.env.AGENT_WORKPLACE_TOKEN!;

describe("agents", () => {
  it("creates an agent whose session runs in its own folder, with its rules, its role's skills, its brief and an MCP config that is that agent", async () => {
    const { app, svc, fake } = start();
    const res = await api(app, "POST", "/api/agents", app.adminToken, { name: "impl-1", role: "implementer", brief: "Say hello, set your status done." });
    expect(res.status).toBe(201);
    const agent = await res.json();
    expect(agent).toMatchObject({ name: "impl-1", role: "implementer", capability: 2, status: "working" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    const s = fake.sessions[0]!;
    const folder = join(app.ctx.agentsDir, "impl-1");
    const state = join(folder, "home", ".claude");
    expect(s.options.cwd).toBe(folder);
    expect(s.options.model).toBe("sonnet");
    // The person's own login: their HOME, and their Claude Code's login store; none of the app's own session.
    expect(s.options.env).toMatchObject({ HOME: "/home/someone", PATH: "/bin", CLAUDE_CONFIG_DIR: state, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/someone/.claude-login" });
    expect(s.options.env.CLAUDECODE).toBeUndefined();
    expect(s.options.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.options.resume).toBeUndefined();
    expect(s.sent).toEqual(["Say hello, set your status done."]);

    const rules = readFileSync(join(state, "CLAUDE.md"), "utf8");
    expect(rules).toContain(`You are agent \`impl-1\`, and your folder is \`${folder}\``);
    expect(rules).toContain("the person's own machine, with their own accounts");
    expect(rules).toContain("`set_status`");
    expect(rules.indexOf("First the implementer's rule.")).toBeGreaterThan(rules.indexOf("## Your role: implementer"));
    expect(rules.indexOf("Then the testing rule.")).toBeGreaterThan(rules.indexOf("First the implementer's rule."));
    expect(rules.indexOf("## Your brief")).toBeGreaterThan(rules.indexOf("Then the testing rule."));
    expect(rules).toContain("Ship the task you are given.\n\nSay hello, set your status done.");
    expect(existsSync(join(state, "skills", "team/testing", "bin", "run"))).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "settings.json"), "utf8")).permissions.deny).toEqual(claude.DENIED);
    expect(JSON.parse(readFileSync(join(folder, "agent.json"), "utf8"))).toEqual({ id: agent.id, name: "impl-1" });

    // Its MCP config reaches the app's /mcp with its own token, which is that agent, kept off the command line.
    expect(s.options.mcpServers).toEqual({
      "agent-workplace": { type: "http", url: "http://127.0.0.1:4799/mcp", headers: { Authorization: "Bearer ${AGENT_WORKPLACE_TOKEN}" } },
    });
    expect(s.options.env.AGENT_WORKPLACE_URL).toBe("http://127.0.0.1:4799");
    expect(await (await api(app, "GET", "/api/me", tokenOf(s))).json()).toEqual({ kind: "agent", agentId: agent.id });
    expect(svc).toBeDefined();
  });

  it("follows a session from create, through the status the agent sets over MCP, to its end", async () => {
    const { app, svc, fake, events } = start();
    const agent = await svc.create({ name: "greeter", brief: "say hello, set your status done" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    const s = fake.sessions[0]!;
    s.say(init("c-1"), text("Hello!"), toolUse("mcp__agent-workplace__set_status", { status: "done", headline: "Said hello" }));
    const client = await mcp(app, tokenOf(s));
    expect(await client.call("set_title", { title: "Says hello" })).toMatchObject({ name: "greeter", title: "Says hello" });
    await expect(client.call("set_title", { title: "Another" })).rejects.toThrow(/has a title already/);
    expect(await client.call("set_status", { status: "done", headline: "Said hello" })).toMatchObject({ name: "greeter", status: "done", headline: "Said hello" });
    // An agent's token is that agent: it cannot set another's status.
    await expect(client.call("set_status", { status: "done", headline: "x", agent: "someone-else" })).rejects.toThrow();
    await client.close();
    s.say(toolResult("ok"), text("Done."), result());
    await vi.waitFor(() => expect(events).toContainEqual({ type: "ended", agentId: agent.id, reason: "done" }));
    expect(s.closed).toBe(true);
    const got = await svc.get("greeter");
    expect(got).toMatchObject({ status: "done", live: false, title: "Says hello" });
    const sessions = svc.sessions(agent.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ claudeSession: "c-1", endReason: "done", turns: 1, tokens: { inputTokens: 1000, outputTokens: 100 } });
    expect(sessions[0]!.costUsd).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6);
    expect(events.filter((e) => e.type === "status").map((e) => (e as { status: string }).status)).toEqual(["done"]);
  });

  it("reads a turn ended with no status set as waiting", async () => {
    const { svc, fake, events } = start();
    const agent = await svc.create({ name: "quiet", brief: "do something" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    fake.sessions[0]!.say(init("c-2"), text("I did something."), result());
    await vi.waitFor(async () => expect(await svc.get("quiet")).toMatchObject({ status: "waiting", headline: SILENT, live: true }));
    expect(events).toContainEqual({ type: "status", agentId: agent.id, status: "waiting" });
    // A message makes it working again, in the same session.
    await svc.send("quiet", "carry on", { kind: "person" });
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.sent).toEqual(["do something", "carry on"]);
    expect(await svc.get("quiet")).toMatchObject({ status: "working", headline: null });
  });

  it("resumes its conversation when a message comes with no live session", async () => {
    const { svc, fake, events } = start();
    const agent = await svc.create({ name: "resumer", brief: "start" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    fake.sessions[0]!.say(init("claude-conv-1"), text("waiting now"), result());
    await vi.waitFor(async () => expect((await svc.get("resumer"))!.status).toBe("waiting"));
    await svc.stop("resumer");
    expect(events).toContainEqual({ type: "ended", agentId: agent.id, reason: "stopped" });
    expect(await svc.get("resumer")).toMatchObject({ status: "idle", live: false });

    await svc.send("resumer", "here is your answer", { kind: "person" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(2));
    const second = fake.sessions[1]!;
    expect(second.options.resume).toBe("claude-conv-1");
    expect(second.options.sessionId).toBeUndefined();
    expect(second.sent).toEqual(["here is your answer"]);
    expect(await svc.get("resumer")).toMatchObject({ status: "working", live: true });
    // Each session has its own token; the last one's no longer works.
    expect(tokenOf(second)).not.toBe(tokenOf(fake.sessions[0]!));
  });

  it("runs no more than the limit at once; the rest wait, highest role priority first, then oldest", async () => {
    const { svc, fake } = start({ maxAgents: 3 });
    for (const n of ["a1", "a2", "a3", "a4"]) await svc.create({ name: n, role: "implementer", brief: `brief ${n}` });
    await svc.admit();
    expect(fake.sessions.map((s) => s.sent[0])).toEqual(["brief a1", "brief a2", "brief a3"]);
    expect(await svc.get("a4")).toMatchObject({ live: false, queued: true });
    await svc.create({ name: "p1", role: "planner", brief: "brief p1" });
    await svc.admit();
    expect(fake.sessions).toHaveLength(3);

    await svc.stop("a1");
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(4));
    expect(fake.sessions[3]!.sent).toEqual(["brief p1"]);
    expect(await svc.get("a4")).toMatchObject({ queued: true });

    // A session that ends by itself frees its room too.
    fake.sessions[1]!.fail("Claude Code exited");
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(5));
    expect(fake.sessions[4]!.sent).toEqual(["brief a4"]);
    expect(await svc.get("a2")).toMatchObject({ status: "waiting", headline: "Its session failed", live: false });
    expect(svc.sessions("a2")[0]!.endReason).toBe("failed");
  });

  it("reads the limit from AGENT_WORKPLACE_MAX_AGENTS", async () => {
    const { svc, fake } = start({ env: { AGENT_WORKPLACE_MAX_AGENTS: "1" } });
    await svc.create({ name: "one", brief: "x" });
    await svc.create({ name: "two", brief: "y" });
    await svc.admit();
    expect(fake.sessions).toHaveLength(1);
  });

  it("keeps the transcript, readable after a cursor, and pushes it live", async () => {
    const { app, svc, fake } = start();
    await svc.create({ name: "talker", brief: "talk" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    fake.sessions[0]!.say(init("c-3"), text("Hi."), toolUse("Bash", { command: "ls" }), toolResult("a\nb"));
    await vi.waitFor(() => expect(svc.lines("talker").lines).toHaveLength(4));
    const all = svc.lines("talker").lines;
    expect(all.map((l) => [l.kind, l.sender, l.text])).toEqual([
      ["message", "person", "talk"],
      ["agent", null, "Hi."],
      ["tool", null, 'Bash {"command":"ls"}'],
      ["result", null, "a\nb"],
    ]);
    expect(all.every((l) => l.sessionId === svc.sessions("talker")[0]!.id)).toBe(true);

    const after = await (await api(app, "GET", `/api/agents/talker/transcript?after=${all[1]!.seq}`, app.adminToken)).json();
    expect(after.lines.map((l: { text: string }) => l.text)).toEqual(['Bash {"command":"ls"}', "a\nb"]);
    expect(after.next).toBe(all[3]!.seq);
    const client = await mcp(app, app.adminToken);
    expect((await client.call("list_transcript_lines", { agent: "talker", after: all[2]!.seq })).lines.map((l: { text: string }) => l.text)).toEqual(["a\nb"]);
    await client.close();

    // The stream sends the lines after its cursor, then each as it is said.
    const res = await api(app, "GET", `/api/agents/talker/transcript/stream?after=${all[2]!.seq}`, app.adminToken);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let got = "";
    const decoder = new TextDecoder();
    const until = async (want: string) => {
      while (!got.includes(want)) got += decoder.decode((await reader.read()).value);
    };
    await until("a\\nb");
    fake.sessions[0]!.say(text("Live line."));
    await until("Live line.");
    expect(got).not.toContain("Hi.");
    expect(got).toContain("event: line");
    await reader.cancel();
  });

  it("stops a session by a usage limit, and resumes it once the limit resets", async () => {
    let now = new Date("2026-11-18T10:00:00.000Z");
    const { svc, fake, events } = start({ now: () => now });
    const agent = await svc.create({ name: "limited", brief: "work" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    const resetsAt = Date.parse("2026-11-18T11:00:00.000Z") / 1000;
    fake.sessions[0]!.say(
      init("c-4"),
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } },
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit" }] } },
      result(0, 0),
    );
    await vi.waitFor(() => expect(events).toContainEqual({ type: "ended", agentId: agent.id, reason: "limit" }));
    expect(await svc.get("limited")).toMatchObject({ status: "waiting", limitedUntil: "2026-11-18T11:00:00.000Z", live: false, queued: true });
    await svc.admit();
    expect(fake.sessions).toHaveLength(1);
    now = new Date("2026-11-18T11:02:00.000Z");
    await svc.admit();
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[1]!.options.resume).toBe("c-4");
    expect(fake.sessions[1]!.sent).toEqual([RESUME_TEXT]);
    expect(await svc.get("limited")).toMatchObject({ status: "working", limitedUntil: null });
  });

  it("makes an agent created on a task its assignee and moves the task in_progress", async () => {
    const { app, svc } = start();
    const task = (await (await api(app, "POST", "/api/tasks", app.adminToken, { title: "Do a thing", description: "x" })).json()).task;
    const agent = await svc.create({ name: "impl-task", role: "implementer", task: task.shortId, brief: "do it" });
    expect(agent.task).toBe(task.id);
    expect(await app.ctx.services.tasks.get(task.id)).toMatchObject({ status: "in_progress", assignee: "impl-task" });
  });

  it("refuses a bad name, a name taken, and an agent on a task that cannot start", async () => {
    const { app, svc } = start();
    await expect(svc.create({ name: "Bad Name", brief: "x" })).rejects.toThrow(/not an agent name/);
    await svc.create({ name: "taken", brief: "x" });
    expect((await api(app, "POST", "/api/agents", app.adminToken, { name: "taken", brief: "x" })).status).toBe(409);
    const first = (await (await api(app, "POST", "/api/tasks", app.adminToken, { title: "First", description: "x" })).json()).task;
    const second = (await (await api(app, "POST", "/api/tasks", app.adminToken, { title: "Second", description: "x", dependsOn: [first.id] })).json()).task;
    await expect(svc.create({ name: "blocked", task: second.id, brief: "x" })).rejects.toThrow();
    expect(await svc.get("blocked")).toBeUndefined();
  });

  it("closes an agent, reopens it with a message, and deletes it with its folder and token", async () => {
    const { svc, fake } = start();
    const agent = await svc.create({ name: "closer", brief: "x" });
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    const token = tokenOf(fake.sessions[0]!);
    await svc.close("closer");
    expect((await svc.get("closer"))!.closedAt).not.toBeNull();
    await svc.send("closer", "again", { kind: "person" });
    expect((await svc.get("closer"))!.closedAt).toBeNull();
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(2));
    await svc.delete(agent.id);
    expect(await svc.get("closer")).toBeUndefined();
    expect(existsSync(svc.folder("closer"))).toBe(false);
    expect(token).toBeTruthy();
  });

  it("asks an agent cut off mid-turn by the app stopping to carry on when it starts again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awp-agents-"));
    const first = start({}, dir);
    await first.svc.create({ name: "survivor", brief: "long work" });
    await vi.waitFor(() => expect(first.fake.sessions).toHaveLength(1));
    first.fake.sessions[0]!.say(init("c-5"), text("working on it"));
    await vi.waitFor(() => expect(first.svc.lines("survivor").lines).toHaveLength(2));
    await first.app.close();
    apps = apps.filter((a) => a !== first.app);
    const second = start({}, dir);
    await vi.waitFor(() => expect(second.fake.sessions).toHaveLength(1));
    expect(second.fake.sessions[0]!.options.resume).toBe("c-5");
    expect(second.fake.sessions[0]!.sent[0]).toMatch(/restarted while you were working/);
  });
});

describe("what a Claude Code message says", () => {
  it("denies only the tools that wait on a terminal", () => {
    expect(claude.permit("Bash")).toBe(true);
    expect(claude.permit("AskUserQuestion")).toMatch(/ask in your reply/);
  });

  it("leaves out of a session's environment what belongs to the app's own Claude Code session", () => {
    expect(claude.baseEnv({ HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_OAUTH_TOKEN: "keep", AGENT_WORKPLACE_TOKEN: "t" })).toEqual({ HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "keep" });
  });

  it("passes over a login folder inside the agents folder", () => {
    expect(claude.loginDir("/data/agents/x/home/.claude", "/data/agents")).toBeNull();
    expect(claude.loginDir("/home/me/.claude", "/data/agents")).toBe("/home/me/.claude");
    expect(claude.loginDir(undefined, "/data/agents")).toBeNull();
  });

  it("skips a subagent's own messages and cuts a long tool result", () => {
    expect(claude.read({ ...text("inner"), parent_tool_use_id: "t9" }, "opus").lines).toEqual([]);
    const long = claude.read(toolResult("x".repeat(5000)), "opus").lines[0]!.text;
    expect(long).toMatch(/\[cut: 4096 of 5000 characters\]$/);
  });
});
