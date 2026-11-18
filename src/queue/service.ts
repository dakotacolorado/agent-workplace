import type { Agents, Caller, Capability, Task, Tasks } from "../contracts.ts";
import type { Context } from "../module.ts";

export const DEFAULT_ROLE = "implementer";
export const DEFAULT_LIMIT = 2;
export const MAX_LIMIT = 50;
export const LOOK_EVERY_MS = 30_000;

/** A task closed for the queue: nothing more to start on it. */
const OPEN = new Set(["backlog", "in_progress", "review"]);

/** One task in the queue, and what the queue did with it. */
export interface Entry {
  taskId: string;
  position: number;
  role: string;
  /** `queued` waits to start; `started` has an agent; `finished` once its task closed; `dropped` when it can no longer run. */
  state: "queued" | "started" | "finished" | "dropped";
  /** Why it has not started, or why it was dropped. */
  note: string | null;
  /** `person`, or the agent's name. */
  queuedBy: string;
  agentName: string | null;
  queuedAt: string;
  startedAt: string | null;
}

export class Conflict extends Error {}
export class Invalid extends Error {}

/** What a task carries at run time beyond the contract: `metadata` and `blockedBy` (see the tasks module). */
type TaskPlus = Task & { metadata?: Record<string, unknown>; blockedBy?: string[] };

/** The first message of an agent started on `task`. */
export function briefFor(task: Task): string {
  const lines = [
    `Work on waypoint task ${task.shortId}: ${task.title}`,
    "",
    `Read it in full first: GetTask ${task.id} on the waypoint MCP server, or \`curl -H "Authorization: Bearer $WAYPOINT_TOKEN" "$WAYPOINT_URL/tasks/${task.id}"\`, with its comments (\`/tasks/${task.id}/comments\`).`,
  ];
  if (task.criteria.length) {
    lines.push("", "It is done when:");
    for (const c of task.criteria) lines.push(`- [${c.met ? "x" : " "}] ${c.id}: ${c.text}`);
  }
  lines.push(
    "",
    "Move it to `in_progress` as you start. Mark each criterion met once you have seen it hold yourself. When your change is submitted, move the task to `review` and say so with your status; the person closes it.",
  );
  return lines.join("\n");
}

/** The capability a task's agent needs: its `metadata.difficulty` (1 easy, 2 medium, 3 hard), null when it has none. Throws when it is something else. */
export function difficultyOf(task: TaskPlus): Capability | null {
  const value = task.metadata?.difficulty;
  if (value === undefined || value === null) return null;
  if (value !== 1 && value !== 2 && value !== 3) throw new TypeError("metadata.difficulty must be 1, 2 or 3");
  return value;
}

/** The agent's name: `impl-<short id>` for the implementer, `<role>-<short id>` for another. */
export const agentNameFor = (role: string, task: Task): string => `${role === DEFAULT_ROLE ? "impl" : role.slice(0, 24)}-${task.shortId}`;

export class QueueService {
  private readonly ctx: Context;
  private readonly now: () => Date;
  private ticking = false;
  private again = false;
  private unsubscribe: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(ctx: Context, options: { now?: () => Date } = {}) {
    this.ctx = ctx;
    this.now = options.now ?? (() => new Date());
  }

  private get tasks(): Tasks {
    return this.ctx.services.tasks;
  }
  private get agents(): Agents {
    return this.ctx.services.agents;
  }

  /** Listens for closed tasks and ended sessions, and looks every `everyMs`. Called once every module exists. */
  begin(everyMs: number): void {
    if (this.closed || this.timer) return;
    this.unsubscribe.push(this.tasks.onEvent(() => void this.tick()));
    this.unsubscribe.push(this.agents.onEvent((e) => e.type === "ended" && void this.tick()));
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
    void this.tick();
  }

  close(): void {
    this.closed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    if (this.timer) clearInterval(this.timer);
  }

  get limit(): number {
    const row = this.ctx.db.prepare("SELECT value FROM queue_settings WHERE key = 'limit'").get() as { value: string } | undefined;
    return row ? Number(row.value) : DEFAULT_LIMIT;
  }

  setLimit(n: number): number {
    if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) throw new Invalid(`limit must be a whole number from 0 to ${MAX_LIMIT}`);
    this.ctx.db.prepare("INSERT INTO queue_settings (key, value) VALUES ('limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
    return n;
  }

  /** Every entry: the queue in order first, then what was started (newest first), then finished and dropped. */
  list(): Entry[] {
    const rows = this.ctx.db
      .prepare("SELECT * FROM queue_entries ORDER BY CASE state WHEN 'queued' THEN 0 WHEN 'started' THEN 1 ELSE 2 END, CASE state WHEN 'queued' THEN position END, started_at DESC, queued_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map(entryOf);
  }

  get(taskId: string): Entry | undefined {
    const row = this.ctx.db.prepare("SELECT * FROM queue_entries WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    return row ? entryOf(row) : undefined;
  }

  /** Queues a task at the back, or before another queued one; queuing it again moves it. Then looks at once. */
  async queue(id: string, by: Caller, options: { role?: string; before?: string } = {}): Promise<Entry> {
    const task = await this.tasks.get(id);
    if (!task) throw new Invalid(`no task ${id}`);
    if (!OPEN.has(task.status)) throw new Conflict(`task ${task.shortId} is ${task.status}`);
    const existing = this.get(task.id);
    if (existing?.state === "started") throw new Conflict(`${task.shortId} is already started, as ${existing.agentName ?? "an agent"}`);
    let before: Entry | undefined;
    if (options.before) {
      const other = await this.tasks.get(options.before);
      before = other && this.get(other.id);
      if (!before || before.state !== "queued") throw new Conflict(`${options.before} is not queued`);
    }
    const position = before ? this.positionBefore(before.position) : this.backPosition();
    const role = options.role ?? existing?.role ?? DEFAULT_ROLE;
    const who = by.kind === "person" ? "person" : ((await this.agents.get(by.agentId))?.name ?? by.agentId);
    this.ctx.db
      .prepare(`INSERT INTO queue_entries (task_id, position, role, state, note, queued_by, agent_name, queued_at, started_at)
        VALUES (?, ?, ?, 'queued', NULL, ?, NULL, ?, NULL)
        ON CONFLICT(task_id) DO UPDATE SET position = excluded.position, role = excluded.role, state = 'queued', note = NULL, queued_by = excluded.queued_by, agent_name = NULL, started_at = NULL`)
      .run(task.id, position, role, who, this.now().toISOString());
    await this.tick();
    return this.get(task.id)!;
  }

  /** Takes a queued task out of the queue, by task id or short id. False when it was not queued. */
  async dequeue(id: string): Promise<boolean> {
    const taskId = (await this.tasks.get(id))?.id ?? id;
    return Number(this.ctx.db.prepare("DELETE FROM queue_entries WHERE task_id = ? AND state = 'queued'").run(taskId).changes) > 0;
  }

  private backPosition(): number {
    const row = this.ctx.db.prepare("SELECT MAX(position) AS p FROM queue_entries WHERE state = 'queued'").get() as { p: number | null };
    return (row.p ?? 0) + 1;
  }

  private positionBefore(at: number): number {
    const row = this.ctx.db.prepare("SELECT MAX(position) AS p FROM queue_entries WHERE state = 'queued' AND position < ?").get(at) as { p: number | null };
    return ((row.p ?? at - 1) + at) / 2;
  }

  private set(taskId: string, fields: Partial<Pick<Entry, "state" | "note" | "agentName" | "startedAt">>): void {
    const cols = { state: "state", note: "note", agentName: "agent_name", startedAt: "started_at" } as const;
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    this.ctx.db.prepare(`UPDATE queue_entries SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE task_id = ?`).run(...keys.map((k) => fields[k] ?? null), taskId);
  }

  /**
   * One look: a started task that has closed is finished, freeing room; then, while fewer than
   * `limit` run, the next queued tasks that are ready are started, in queue order. A task not
   * ready keeps its place and its entry says why. A look asked for during one is run after it.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        await this.look();
      } while (this.again && !this.closed);
    } finally {
      this.ticking = false;
    }
  }

  private async look(): Promise<void> {
    if (this.closed) return;
    for (const entry of this.list().filter((e) => e.state === "started")) {
      const task = await this.tasks.get(entry.taskId);
      if (!task) this.set(entry.taskId, { state: "finished", note: "task deleted" });
      else if (!OPEN.has(task.status)) this.set(entry.taskId, { state: "finished", note: `task ${task.status}` });
    }
    let running = this.list().filter((e) => e.state === "started").length;
    const queued = this.list().filter((e) => e.state === "queued");
    if (queued.length === 0) return;
    const ready = new Set((await this.tasks.listReady()).map((t) => t.id));
    for (const entry of queued) {
      if (this.closed) return;
      const task = (await this.tasks.get(entry.taskId)) as TaskPlus | undefined;
      if (!task) {
        this.set(entry.taskId, { state: "dropped", note: "no such task" });
        continue;
      }
      if (!OPEN.has(task.status)) {
        this.set(entry.taskId, { state: "dropped", note: `task is ${task.status}` });
        continue;
      }
      if (task.assignee) {
        this.set(entry.taskId, { note: `waits: assigned to ${task.assignee}` });
        continue;
      }
      if (!ready.has(task.id)) {
        const open = task.blockedBy ?? [];
        this.set(entry.taskId, { note: open.length ? `waits: blocked by ${open.map((b) => b.slice(0, 8)).join(", ")}` : `waits: task is ${task.status}, not ready` });
        continue;
      }
      if (running >= this.limit) {
        this.set(entry.taskId, { note: this.limit === 0 ? "waits: the queue is paused (limit 0)" : `waits: at the limit (${this.limit} running)` });
        continue;
      }
      let capability: Capability | null;
      try {
        capability = difficultyOf(task);
      } catch (err) {
        this.set(entry.taskId, { note: `waits: ${(err as Error).message}` });
        continue;
      }
      try {
        const agent = await this.agents.create({ name: agentNameFor(entry.role, task), role: entry.role, task: task.id, brief: briefFor(task), ...(capability ? { capability } : {}) }, { kind: "person" });
        this.set(entry.taskId, { state: "started", note: null, agentName: agent.name, startedAt: this.now().toISOString() });
        running++;
      } catch (err) {
        this.set(entry.taskId, { note: `agents: ${(err as Error).message}` });
      }
    }
  }
}

function entryOf(r: Record<string, unknown>): Entry {
  return {
    taskId: r.task_id as string,
    position: r.position as number,
    role: r.role as string,
    state: r.state as Entry["state"],
    note: (r.note as string | null) ?? null,
    queuedBy: r.queued_by as string,
    agentName: (r.agent_name as string | null) ?? null,
    queuedAt: r.queued_at as string,
    startedAt: (r.started_at as string | null) ?? null,
  };
}
