/**
 * The agents and their sessions. An agent is a row and a folder; while it has
 * a session, a Claude Code session (runner.ts) runs in that folder, takes
 * messages as it works and says what it does. Everything it says is kept as
 * transcript lines, and its raw messages in `logs/<session>.jsonl` in its
 * folder. At most `maxAgents` sessions run at once: a session asked for past
 * that waits as a request, and requests start highest role priority first,
 * then oldest.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, AgentEvent, Agents, AgentStatus, Caller, Capability, NewAgent, SaidStatus, SessionEndReason, Skill } from "../contracts.ts";
import { NotBuilt, type Context } from "../module.ts";
import * as claude from "./claude.ts";
import { rules } from "./rules.ts";
import type { SessionHandle, StartSession } from "./runner.ts";

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const HEADLINE_LIMIT = 60;
export const TITLE_LIMIT = 40;
export const DEFAULT_MAX_AGENTS = 3;
export const DEFAULT_CAPABILITY: Capability = 3;

/** How long past a usage limit's reset its agent is left, so the reset is surely past. */
export const RESUME_AFTER_MS = 60_000;
/** How often waiting requests are looked at again, for a usage limit that has reset. */
export const LOOK_EVERY_MS = 30_000;
/** How long a stopped session has to end before the app goes on without it. */
const GRACE_MS = 5000;

export const SILENT = "Ended its turn without saying why";

/** Told to a session started only to carry on: a usage limit reset, or the app restarted mid-turn. */
export const RESUME_TEXT = "Your usage limit has reset: carry on where you left off.";
export const RESUMED_TEXT =
  "agent-workplace restarted while you were working, and this session carries on the conversation from before it. Whatever was " +
  "under way -- a reply, a tool -- was cut off and may not have finished: check what was cut off, then carry on where you left off.";

export interface Line {
  /** Increases across every agent's lines: read after one with `after`. */
  seq: number;
  at: string;
  /** The session it was said in; null for a message still waiting for one. */
  sessionId: string | null;
  /** `message` is what the agent was told, by `sender`; `agent` what it said; `tool` a call; `result` what a call answered; `notice` the app's or Claude Code's own. */
  kind: claude.LineKind;
  /** For a message: `person`, an agent's name, or `agent-workplace`. */
  sender: string | null;
  text: string;
}

export interface SessionRecord {
  id: string;
  claudeSession: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  endReason: SessionEndReason | null;
  turns: number;
  tokens: claude.Tokens;
  /** Estimated from list prices. */
  costUsd: number;
}

export type Change = { type: "agent"; agent: Agent } | { type: "line"; agentId: string; line: Line };

export interface AgentsOptions {
  startSession: StartSession;
  maxAgents: number;
  /** The app's own address, where a session's MCP config points (`<url>/mcp`). */
  url: string;
  /** The environment every session starts from, before its own variables. */
  env: Record<string, string>;
  /** The person's Claude login folder (`claude.loginDir`), or null for Claude Code's default. */
  login: string | null;
  now?: () => Date;
  resumeAfterMs?: number;
  lookEveryMs?: number;
}

interface Row {
  id: string;
  name: string;
  role: string | null;
  task: string | null;
  brief: string;
  capability: number;
  status: AgentStatus;
  said_in_turn: number;
  in_turn: number;
  headline: string | null;
  title: string | null;
  claude_session: string | null;
  limited_until: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Live {
  sessionId: string;
  model: string;
  handle: SessionHandle;
  log: string;
  /** Why it is being ended, once something ends it. */
  ending: SessionEndReason | null;
  /** When the usage limit met in the turn under way resets. */
  limited?: string;
  /** The last line it said, when a notice. */
  lastNotice?: string;
  done: Promise<void>;
}

export class AgentService implements Agents {
  private readonly live = new Map<string, Live>();
  private readonly starting = new Set<string>();
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly watchers = new Set<(c: Change) => void>();
  private admitting: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  private readonly ctx: Context;
  private readonly o: AgentsOptions;

  constructor(ctx: Context, o: AgentsOptions) {
    this.ctx = ctx;
    this.o = o;
    this.recover();
    this.timer = setInterval(() => void this.admit(), o.lookEveryMs ?? LOOK_EVERY_MS);
    this.timer.unref();
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  // --- reading ---------------------------------------------------------------

  private row(idOrName: string): Row | undefined {
    return this.ctx.db.prepare("SELECT * FROM agents WHERE id = ? OR name = ?").get(idOrName, idOrName) as Row | undefined;
  }

  private must(idOrName: string): Row {
    const r = this.row(idOrName);
    if (!r) throw new NotFound(`no agent ${idOrName}`);
    return r;
  }

  private served(r: Row): Agent {
    const queued = !!this.ctx.db.prepare("SELECT 1 FROM agent_requests WHERE agent_id = ? LIMIT 1").get(r.id);
    const live = this.live.has(r.id) || this.starting.has(r.id);
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      task: r.task,
      brief: r.brief,
      capability: r.capability as Capability,
      status: r.status,
      headline: r.headline,
      title: r.title,
      live,
      queued: queued && !live,
      limitedUntil: r.limited_until,
      closedAt: r.closed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async get(id: string): Promise<Agent | undefined> {
    const r = this.row(id);
    return r && this.served(r);
  }

  async list(): Promise<Agent[]> {
    return (this.ctx.db.prepare("SELECT * FROM agents ORDER BY created_at, name").all() as unknown as Row[]).map((r) => this.served(r));
  }

  /** The id of the agent named by id or name; throws NotFound. */
  idOf(idOrName: string): string {
    return this.must(idOrName).id;
  }

  folder(name: string): string {
    return join(this.ctx.agentsDir, name);
  }

  sessions(id: string): SessionRecord[] {
    const r = this.must(id);
    const rows = this.ctx.db.prepare("SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at, rowid").all(r.id) as Record<string, unknown>[];
    return rows.map((s) => ({
      id: s.id as string,
      claudeSession: s.claude_session as string,
      model: s.model as string,
      startedAt: s.started_at as string,
      endedAt: (s.ended_at as string | null) ?? null,
      endReason: (s.end_reason as SessionEndReason | null) ?? null,
      turns: s.turns as number,
      tokens: JSON.parse(s.tokens as string) as claude.Tokens,
      costUsd: s.cost_usd as number,
    }));
  }

  /** Its lines after `after` (0: from the start), oldest first, at most `limit`. */
  lines(id: string, after = 0, limit = 500): { lines: Line[]; next: number } {
    const r = this.must(id);
    const rows = this.ctx.db
      .prepare("SELECT * FROM agent_lines WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(r.id, after, Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[];
    const lines = rows.map(lineOf);
    return { lines, next: lines.at(-1)?.seq ?? after };
  }

  // --- events ----------------------------------------------------------------

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every change to an agent and every line, as it happens: for the live feed. */
  watch(watcher: (change: Change) => void): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  private emit(e: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // One listener's failure is its own.
      }
    }
  }

  private changed(id: string): void {
    const r = this.row(id);
    if (!r) return;
    const agent = this.served(r);
    for (const w of this.watchers) w({ type: "agent", agent });
  }

  /** Writes `fields` on the agent; emits a status event when its status changes, and a change for the feed. */
  private update(id: string, fields: Partial<Omit<Row, "id">>): void {
    const before = this.row(id);
    if (!before) return;
    const keys = Object.keys(fields);
    if (keys.length) {
      const sql = `UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
      this.ctx.db.prepare(sql).run(...(keys.map((k) => (fields as Record<string, never>)[k]) as never[]), this.now(), id);
    }
    if (fields.status && fields.status !== before.status) this.emit({ type: "status", agentId: id, status: fields.status });
    this.changed(id);
  }

  private say(id: string, sessionId: string | null, kind: claude.LineKind, text: string, sender: string | null = null): Line {
    const at = this.now();
    const res = this.ctx.db
      .prepare("INSERT INTO agent_lines (agent_id, session_id, at, kind, sender, text) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, sessionId, at, kind, sender, text);
    const line: Line = { seq: Number(res.lastInsertRowid), at, sessionId, kind, sender, text };
    for (const w of this.watchers) w({ type: "line", agentId: id, line });
    return line;
  }

  // --- the work --------------------------------------------------------------

  async create(n: NewAgent, by: Caller = { kind: "person" }): Promise<Agent> {
    if (this.closed) throw new Error("agent-workplace is stopping");
    if (!NAME.test(n.name)) throw new Invalid(`${JSON.stringify(n.name)} is not an agent name: ${NAME.source}`);
    if (!n.brief?.trim()) throw new Invalid("an agent needs a brief");
    if (this.row(n.name)) throw new Conflict(`an agent is already named ${n.name}`);
    const role = n.role ? await this.ctx.services.roles?.get(n.role).catch(() => undefined) : undefined;
    const capability = n.capability ?? role?.capability ?? DEFAULT_CAPABILITY;
    if (![1, 2, 3].includes(capability)) throw new Invalid("capability is 1, 2 or 3");
    let task = n.task ?? null;
    if (task) {
      // Only once the tasks module holds tasks: a skeleton finds none and moves none.
      const tasks = this.ctx.services.tasks;
      const found = await tasks?.get(task).catch(() => undefined);
      if (found) {
        try {
          await tasks.update(found.id, { assignee: n.name, status: "in_progress" }, by);
        } catch (err) {
          if (!(err instanceof NotBuilt)) throw new Conflict(`task ${task}: ${(err as Error).message}`);
        }
        task = found.id;
      }
    }
    const id = randomUUID();
    const at = this.now();
    this.ctx.db
      .prepare("INSERT INTO agents (id, name, role, task, brief, capability, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'working', ?, ?)")
      .run(id, n.name, n.role ?? null, task, n.brief, capability, at, at);
    const dir = this.folder(n.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "agent.json"), `${JSON.stringify({ id, name: n.name }, null, 2)}\n`);
    this.request(id, n.brief, this.senderOf(by));
    void this.admit();
    return this.served(this.must(id));
  }

  private senderOf(by: Caller): string {
    if (by.kind === "person") return "person";
    return this.row(by.agentId)?.name ?? by.agentId;
  }

  /** Records `text` as a message to the agent, to be delivered when its next session starts. */
  private request(id: string, text: string, sender: string): void {
    this.say(id, null, "message", text, sender);
    this.ctx.db.prepare("INSERT INTO agent_requests (agent_id, text, created_at) VALUES (?, ?, ?)").run(id, text, this.now());
  }

  async send(id: string, text: string, by: Caller): Promise<void> {
    if (this.closed) throw new Error("agent-workplace is stopping");
    if (!text.trim()) throw new Invalid("a message needs text");
    const r = this.must(id);
    // Told something, it is at work again: what it said goes, and a closed agent reopens.
    const fields: Partial<Row> = { status: "working", headline: null, closed_at: null };
    // A person's message is worth a try past a usage limit; it is told again once the limit resets.
    if (by.kind === "person") fields.limited_until = null;
    const live = this.live.get(r.id);
    if (live && !live.ending) {
      if (!r.in_turn) Object.assign(fields, { in_turn: 1, said_in_turn: 0 });
      this.update(r.id, fields);
      this.say(r.id, live.sessionId, "message", text, this.senderOf(by));
      live.handle.send(text);
      return;
    }
    this.update(r.id, fields);
    this.request(r.id, text, this.senderOf(by));
    void this.admit();
  }

  /** What the agent says of itself; the person may say it for an agent too. */
  setStatus(id: string, status: SaidStatus, headline: string): Agent {
    const r = this.must(id);
    if (!["working", "waiting", "review", "done"].includes(status)) throw new Invalid("status is working, waiting, review or done");
    if (headline.length > HEADLINE_LIMIT) throw new Invalid(`a headline is at most ${HEADLINE_LIMIT} characters`);
    this.update(r.id, { status, headline: headline || null, said_in_turn: 1 });
    return this.served(this.must(r.id));
  }

  /** Set once by the agent; the person can change it after. */
  setTitle(id: string, title: string, by: Caller): Agent {
    const r = this.must(id);
    if (!title.trim() || title.length > TITLE_LIMIT) throw new Invalid(`a title is 1 to ${TITLE_LIMIT} characters`);
    if (by.kind === "agent" && r.title) throw new Conflict(`${r.name} has a title already, ${JSON.stringify(r.title)}: only the person changes it`);
    this.update(r.id, { title });
    return this.served(this.must(r.id));
  }

  async stop(id: string): Promise<void> {
    const r = this.must(id);
    this.ctx.db.prepare("DELETE FROM agent_requests WHERE agent_id = ?").run(r.id);
    await this.end(r.id, "stopped");
    const after = this.must(r.id);
    if (after.status !== "review" && after.status !== "done") this.update(r.id, { status: "idle", headline: null, in_turn: 0 });
    else this.changed(r.id);
  }

  async close(id: string): Promise<void> {
    await this.stop(id);
    this.update(this.must(id).id, { closed_at: this.now() });
  }

  async delete(id: string): Promise<void> {
    const r = this.must(id);
    await this.stop(r.id);
    this.ctx.tokens.revoke(r.id);
    this.ctx.db.prepare("DELETE FROM agents WHERE id = ?").run(r.id);
    rmSync(this.folder(r.name), { recursive: true, force: true });
  }

  /** Ends the agent's live session for `reason`, waiting a while for it to finish. */
  private async end(id: string, reason: SessionEndReason): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    live.ending ??= reason;
    live.handle.close();
    await Promise.race([live.done, new Promise((r) => setTimeout(r, GRACE_MS).unref())]);
  }

  // --- admission -------------------------------------------------------------

  /** Starts waiting requests while there is room, highest role priority first, then oldest; one look at a time. */
  admit(): Promise<void> {
    this.admitting = this.admitting.then(() => this.admitNow()).catch(() => {});
    return this.admitting;
  }

  private async admitNow(): Promise<void> {
    while (!this.closed && this.live.size + this.starting.size < this.o.maxAgents) {
      const resetBy = new Date((this.o.now?.() ?? new Date()).getTime() - (this.o.resumeAfterMs ?? RESUME_AFTER_MS)).toISOString();
      const waiting = (
        this.ctx.db
          .prepare(
            "SELECT a.id, a.role, a.limited_until, MIN(q.seq) AS first FROM agent_requests q JOIN agents a ON a.id = q.agent_id GROUP BY a.id ORDER BY first",
          )
          .all() as { id: string; role: string | null; limited_until: string | null; first: number }[]
      ).filter((w) => !this.live.has(w.id) && !this.starting.has(w.id) && (!w.limited_until || w.limited_until <= resetBy));
      if (!waiting.length) return;
      const priority = new Map<string, number>();
      for (const w of waiting) {
        if (w.role && !priority.has(w.role)) priority.set(w.role, (await this.ctx.services.roles?.get(w.role).catch(() => undefined))?.priority ?? 0);
      }
      const p = (w: (typeof waiting)[number]) => (w.role ? (priority.get(w.role) ?? 0) : 0);
      waiting.sort((a, b) => p(b) - p(a) || a.first - b.first);
      const next = waiting[0]!;
      this.starting.add(next.id);
      try {
        await this.begin(next.id);
      } catch (err) {
        this.ctx.db.prepare("DELETE FROM agent_requests WHERE agent_id = ?").run(next.id);
        if (this.row(next.id)) {
          this.say(next.id, null, "notice", `Could not start a session: ${(err as Error).message}`);
          this.update(next.id, { status: "waiting", headline: "Could not start a session", in_turn: 0 });
        }
      } finally {
        this.starting.delete(next.id);
      }
    }
  }

  /** Starts a session for the agent, carrying on its conversation if it has one, and tells it every message waiting for it. */
  private async begin(id: string): Promise<void> {
    const r = this.must(id);
    const role = r.role ? await this.ctx.services.roles?.get(r.role).catch(() => undefined) : undefined;
    const skills: Skill[] = [];
    for (const name of role?.skills ?? []) {
      const s = await this.ctx.services.skills?.get(name).catch(() => undefined);
      if (s) skills.push(s);
    }
    const dir = this.folder(r.name);
    const state = join(dir, "home", ".claude");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "agent.json"), `${JSON.stringify({ id: r.id, name: r.name }, null, 2)}\n`);
    claude.prepare(state, dir, rules({ name: r.name, dir, role: r.role, skills, roleBrief: role?.brief, brief: r.brief }));
    for (const s of skills) {
      for (const f of s.files) {
        const file = join(state, "skills", s.name, f.path);
        if (!file.startsWith(join(state, "skills", s.name) + "/")) continue;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, f.content);
        chmodSync(file, f.executable ? 0o755 : 0o644);
      }
    }
    // One token at a time: each session's own, and the last session's no longer works.
    this.ctx.tokens.revoke(r.id);
    const token = this.ctx.tokens.issue(r.id);
    const env = {
      ...this.o.env,
      ...claude.claudeEnv(state, this.o.login),
      AGENT_WORKPLACE_URL: this.o.url,
      AGENT_WORKPLACE_AGENT: r.name,
      AGENT_WORKPLACE_TOKEN: token,
    };
    // Claude Code fills `${VAR}` from the session's environment, so the token is never on its command line.
    const mcpServers = {
      "agent-workplace": { type: "http", url: `${this.o.url}/mcp`, headers: { Authorization: "Bearer ${AGENT_WORKPLACE_TOKEN}" } },
    };
    writeFileSync(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
    const model = claude.MODELS[r.capability as Capability];
    const sessionId = randomUUID();
    const fresh = randomUUID();
    const log = join(dir, "logs", `${sessionId}.jsonl`);
    mkdirSync(dirname(log), { recursive: true });
    const requests = this.ctx.db.prepare("SELECT seq, text FROM agent_requests WHERE agent_id = ? ORDER BY seq").all(r.id) as { seq: number; text: string }[];
    const handle = this.o.startSession({
      cwd: dir,
      env,
      ...(r.claude_session ? { resume: r.claude_session } : { sessionId: fresh }),
      mcpServers,
      model,
      permit: claude.permit,
      stderr: (t) => {
        try {
          appendFileSync(join(dir, "logs", `${sessionId}.stderr`), t);
        } catch {
          // For a person reading after; losing some loses nothing the app needs.
        }
      },
    });
    const at = this.now();
    this.ctx.db
      .prepare("INSERT INTO agent_sessions (id, agent_id, claude_session, model, started_at, tokens) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sessionId, r.id, r.claude_session ?? fresh, model, at, JSON.stringify(claude.NO_TOKENS));
    if (!r.claude_session) this.ctx.db.prepare("UPDATE agents SET claude_session = ? WHERE id = ?").run(fresh, r.id);
    const live: Live = { sessionId, model, handle, log, ending: null, done: Promise.resolve() };
    this.live.set(r.id, live);
    this.ctx.db.prepare("DELETE FROM agent_requests WHERE agent_id = ? AND seq <= ?").run(r.id, requests.at(-1)?.seq ?? 0);
    this.ctx.db.prepare("UPDATE agent_lines SET session_id = ? WHERE agent_id = ? AND session_id IS NULL AND kind = 'message'").run(sessionId, r.id);
    this.update(r.id, { in_turn: 1, said_in_turn: 0, limited_until: null, ...(r.status === "working" ? {} : { status: "working" as const }) });
    live.done = this.pump(r.id, live);
    for (const q of requests) handle.send(q.text);
  }

  /** Keeps everything the session says until it ends, and follows its turns. */
  private async pump(id: string, live: Live): Promise<void> {
    let failed: string | null = null;
    try {
      for await (const m of live.handle.events) {
        try {
          appendFileSync(live.log, `${JSON.stringify(m)}\n`);
        } catch {
          // The transcript lines are the record that matters.
        }
        if (!this.row(id)) continue;
        this.follow(id, live, m);
      }
    } catch (err) {
      if (!live.ending) failed = (err as Error).message || String(err);
    } finally {
      this.live.delete(id);
      const reason: SessionEndReason = live.ending ?? (failed ? "failed" : "ended");
      this.ctx.db.prepare("UPDATE agent_sessions SET ended_at = ?, end_reason = ? WHERE id = ?").run(this.now(), reason, live.sessionId);
      const r = this.row(id);
      if (r) {
        if (failed) this.say(id, live.sessionId, "notice", `The session failed: ${failed}`);
        const keep = r.status === "review" || r.status === "done" || reason === "limit" || reason === "shutdown";
        this.update(id, { in_turn: 0, ...(keep ? {} : failed ? { status: "waiting" as const, headline: "Its session failed" } : { status: "idle" as const, headline: null }) });
        this.emit({ type: "ended", agentId: id, reason });
      }
      if (!this.closed) void this.admit();
    }
  }

  private follow(id: string, live: Live, m: unknown): void {
    const said = claude.read(m, live.model);
    if (said.claudeSession) {
      this.ctx.db.prepare("UPDATE agents SET claude_session = ? WHERE id = ?").run(said.claudeSession, id);
      this.ctx.db.prepare("UPDATE agent_sessions SET claude_session = ? WHERE id = ?").run(said.claudeSession, live.sessionId);
    }
    for (const l of said.lines) {
      // Claude Code says a failed turn's reason twice, as a notice and as its result: kept once.
      if (l.kind === "notice" && l.text === live.lastNotice) continue;
      live.lastNotice = l.kind === "notice" ? l.text : undefined;
      this.say(id, live.sessionId, l.kind, l.text);
    }
    if (said.limitedUntil) live.limited = said.limitedUntil;
    const r = this.must(id);
    // A turn it began by itself, as a background task's end begins one.
    if (said.working && !r.in_turn) this.update(id, { in_turn: 1, said_in_turn: 0, ...(r.status === "working" ? {} : { status: "working" as const }) });
    if (!said.turnEnded) return;
    if (said.byModel) {
      const s = this.ctx.db.prepare("SELECT tokens, cost_usd FROM agent_sessions WHERE id = ?").get(live.sessionId) as { tokens: string; cost_usd: number };
      let tokens = JSON.parse(s.tokens) as claude.Tokens;
      let cost = s.cost_usd;
      for (const [model, t] of Object.entries(said.byModel)) {
        tokens = claude.addTokens(tokens, t);
        cost += claude.cost(model, t);
      }
      this.ctx.db.prepare("UPDATE agent_sessions SET tokens = ?, cost_usd = ?, turns = turns + 1 WHERE id = ?").run(JSON.stringify(tokens), cost, live.sessionId);
    } else {
      this.ctx.db.prepare("UPDATE agent_sessions SET turns = turns + 1 WHERE id = ?").run(live.sessionId);
    }
    const after = this.must(id);
    if (live.limited) {
      // Stopped by a usage limit: its room goes to others, and it is told to carry on once the limit resets.
      const until = live.limited;
      live.limited = undefined;
      this.update(id, { in_turn: 0, status: "waiting", headline: "Waits for its usage limit to reset", limited_until: until });
      this.request(id, RESUME_TEXT, "agent-workplace");
      live.ending = "limit";
      live.handle.close();
      return;
    }
    if (!after.said_in_turn) {
      this.update(id, { in_turn: 0, status: "waiting", headline: SILENT });
      return;
    }
    this.update(id, { in_turn: 0 });
    // Done or in review, its session gives its room to others; a message starts it again.
    if (after.status === "done" || after.status === "review") {
      live.ending = "done";
      live.handle.close();
    }
  }

  // --- the app starting and stopping ---------------------------------------------

  /** Sessions an app that died left open are ended; an agent cut off mid-turn is asked to carry on. */
  private recover(): void {
    const open = this.ctx.db.prepare("SELECT id FROM agent_sessions WHERE ended_at IS NULL").all() as { id: string }[];
    for (const s of open) this.ctx.db.prepare("UPDATE agent_sessions SET ended_at = ?, end_reason = 'shutdown' WHERE id = ?").run(this.now(), s.id);
    const cut = this.ctx.db.prepare("SELECT id FROM agents WHERE in_turn = 1").all() as { id: string }[];
    for (const a of cut) {
      this.ctx.db.prepare("UPDATE agents SET in_turn = 0 WHERE id = ?").run(a.id);
      this.request(a.id, RESUMED_TEXT, "agent-workplace");
    }
    // Once every module is created: roles and skills are read when a session starts.
    setImmediate(() => void this.admit());
  }

  /** Ends every session; one cut off mid-turn is asked to carry on when the app starts again. */
  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.admitting;
    const ids = [...this.live.keys()];
    for (const id of ids) {
      const r = this.row(id);
      if (r?.in_turn) this.request(id, RESUMED_TEXT, "agent-workplace");
    }
    await Promise.all(ids.map((id) => this.end(id, "shutdown")));
  }
}

function lineOf(row: Record<string, unknown>): Line {
  return {
    seq: row.seq as number,
    at: row.at as string,
    sessionId: (row.session_id as string | null) ?? null,
    kind: row.kind as claude.LineKind,
    sender: (row.sender as string | null) ?? null,
    text: row.text as string,
  };
}

export class NotFound extends Error {}
export class Invalid extends Error {}
export class Conflict extends Error {}
