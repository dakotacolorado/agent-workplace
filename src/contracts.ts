/**
 * The interfaces the modules call each other by. Each module owns one of
 * these (its module's `create` returns it as `service`) and reaches the
 * others through `ctx.services`, read at call time, never in `create`.
 *
 * Keep them small: a module's own routes, tools and page can do far more than
 * its interface here, which holds only what another module needs.
 */

/** Who is calling: the person (by the admin token) or one agent (by its own token). */
export type Caller = { kind: "person" } | { kind: "agent"; agentId: string };

// ---------------------------------------------------------------- Tasks

export type TaskStatus = "backlog" | "in_progress" | "review" | "done" | "cancelled";

export interface Criterion {
  id: string;
  text: string;
  met: boolean;
}

export interface Task {
  id: string;
  /** The first 8 characters of `id`; anywhere a task id is taken, this is too. */
  shortId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** The agent name or `"person"` working on it, or null. */
  assignee: string | null;
  /** Ids of the tasks that must close (done or cancelled) before this one can start. */
  dependsOn: string[];
  criteria: Criterion[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  /** The agent's name, or `"person"`. */
  author: string;
  body: string;
  createdAt: string;
}

/** Emitted once when a task moves into a closed status, so the queue can start what it freed. */
export type TaskEvent = { type: "closed"; taskId: string; status: "done" | "cancelled" };

export interface Tasks {
  /** One task by id or short id, or undefined. */
  get(id: string): Promise<Task | undefined>;
  /** Tasks in `backlog` with nobody assigned and every task they depend on closed, oldest first. */
  listReady(): Promise<Task[]>;
  /** Sets status and/or assignee; refuses a move the task's rules forbid (throws). */
  update(id: string, change: { status?: TaskStatus; assignee?: string | null }, by: Caller): Promise<Task>;
  comment(id: string, body: string, by: Caller): Promise<TaskComment>;
  /** Calls `listener` when a task closes (done or cancelled); returns the unsubscribe. */
  onEvent(listener: (event: TaskEvent) => void): () => void;
}

// ---------------------------------------------------------------- Skills

export interface SkillFile {
  /** Relative to the skill's folder; `SKILL.md` is the skill itself. */
  path: string;
  content: string;
  executable?: boolean;
}

export interface Skill {
  /** e.g. `implementer` or `team/code-review`. */
  name: string;
  description: string;
  /** Starts at 1; every write makes the next. */
  version: number;
  files: SkillFile[];
  updatedAt: string;
}

export interface Feedback {
  skill: string;
  /** The skill's exact text the report is about; needed on an existing hard skill. */
  quote?: string;
  /** What the agent saw: a command and its output, a file as it is now. Needed with a quote on a hard skill. */
  evidence?: string;
  /** What the agent did instead, or what it changed. Needed with a quote on a hard skill. */
  whatChanged?: string;
  /** Anything else: for a skill not yet made, what it is for; on a soft skill, the observation. */
  text?: string;
  /** Files suggested for the next version. */
  files?: SkillFile[];
}

/** A skill a module adds to the library the first time the app starts with it. */
export interface StarterSkill {
  name: string;
  files: SkillFile[];
}

export interface Skills {
  /** A skill at its latest version, or at `version`; undefined if none. */
  get(name: string, version?: number): Promise<Skill | undefined>;
  list(): Promise<Skill[]>;
  /** Writes one file (creating the skill if new) as a new version, returned. Only the person writes skills; an agent sends feedback. */
  writeFile(name: string, file: SkillFile, by: Caller, note?: string): Promise<Skill>;
  /** Queues a report for the judge; refused (throws, with how to fix it) when it is not one the judge can decide. */
  submitFeedback(feedback: Feedback, by: Caller): Promise<{ id: string }>;
  /** Adds each skill the library has never held (one the person deleted stays deleted); returns the names added. */
  seed(starters: StarterSkill[]): Promise<string[]>;
}

// ---------------------------------------------------------------- Roles

/** How capable a model a role's agents need: 1 easy, 2 medium, 3 hard. */
export type Capability = 1 | 2 | 3;

export interface Role {
  /** e.g. `implementer`. */
  name: string;
  description: string;
  /** Names of the skills its agents start with, in order. */
  skills: string[];
  /** Higher runs first when the queue has more ready work than room. */
  priority: number;
  capability: Capability;
  /** The brief an agent of this role is started with, before its own. */
  brief: string;
}

export interface Roles {
  list(): Promise<Role[]>;
  get(name: string): Promise<Role | undefined>;
}

// ---------------------------------------------------------------- Agents

/**
 * `working` while a turn of its runs (or it said so), `waiting` once it needs
 * the person (said, or a turn ended with nothing said), `review` and `done` as
 * it said them, and `idle` with no live session and nothing of those said.
 */
export type AgentStatus = "working" | "idle" | "waiting" | "review" | "done";

/** What an agent may say of itself with `set_status`. */
export type SaidStatus = "working" | "waiting" | "review" | "done";

export interface Agent {
  id: string;
  /** Unique: `^[a-z0-9][a-z0-9-]{0,39}$`. Its folder is `<dir>/agents/<name>/`. */
  name: string;
  role: string | null;
  /** The task id it was started on, or null. */
  task: string | null;
  brief: string;
  /** 1 Haiku, 2 Sonnet, 3 Opus. */
  capability: Capability;
  status: AgentStatus;
  /** What it last said with its status, in a few words; null until it says. */
  headline: string | null;
  /** What it is there to do, set once by itself (or by the person). */
  title: string | null;
  /** True while a session of its runs. */
  live: boolean;
  /** True while it waits for room under the limit to start a session. */
  queued: boolean;
  /** When the usage limit that stopped its session resets, while it waits for it; null otherwise. */
  limitedUntil: string | null;
  /** When it was closed; a message reopens it. Null while open. */
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAgent {
  name: string;
  role?: string;
  task?: string;
  brief: string;
  /** Absent, the role's, or 3. */
  capability?: Capability;
}

/** `stopped` by a stop, close or delete; `done` once it ended a turn in `done` or `review`; `ended` by itself; `failed`; `limit` by a usage limit; `shutdown` when the app stopped. */
export type SessionEndReason = "stopped" | "done" | "ended" | "failed" | "limit" | "shutdown";

export type AgentEvent =
  | { type: "status"; agentId: string; status: AgentStatus }
  | { type: "ended"; agentId: string; reason: SessionEndReason };

export interface Agents {
  /** Makes the agent and asks for its first session, which starts once there is room under the limit. On a task, it becomes the assignee and moves it `in_progress`, as `by` (default the person). */
  create(agent: NewAgent, by?: Caller): Promise<Agent>;
  /** By id or name. */
  get(id: string): Promise<Agent | undefined>;
  list(): Promise<Agent[]>;
  /** Delivers a message as the agent's next turn, starting a session that carries on its conversation when none is live. */
  send(id: string, text: string, by: Caller): Promise<void>;
  /** Ends its live session, if any, and any waiting to start; the agent stays. */
  stop(id: string): Promise<void>;
  /** Stops it and marks it closed; a message reopens it. */
  close(id: string): Promise<void>;
  /** Stops it and removes it, its tokens, transcript and folder. */
  delete(id: string): Promise<void>;
  /** Calls `listener` on every status change and session end; returns the unsubscribe. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

/** Every module's interface, by module name. */
export interface Services {
  tasks: Tasks;
  skills: Skills;
  roles: Roles;
  agents: Agents;
}
