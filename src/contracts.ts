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

export interface Tasks {
  /** One task by id or short id, or undefined. */
  get(id: string): Promise<Task | undefined>;
  /** Tasks in `backlog` with nobody assigned and every task they depend on closed, oldest first. */
  listReady(): Promise<Task[]>;
  /** Sets status and/or assignee; refuses a move the task's rules forbid (throws). */
  update(id: string, change: { status?: TaskStatus; assignee?: string | null }, by: Caller): Promise<Task>;
  comment(id: string, body: string, by: Caller): Promise<TaskComment>;
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
  /** The skill's exact text the report is about. */
  quote?: string;
  /** What the agent saw: a command and its output, a file as it is now. */
  evidence: string;
  /** What the agent did instead, or what it changed. */
  whatChanged?: string;
  /** Files suggested for the next version. */
  files?: SkillFile[];
}

export interface Skills {
  /** A skill at its latest version, or at `version`; undefined if none. */
  get(name: string, version?: number): Promise<Skill | undefined>;
  list(): Promise<Skill[]>;
  /** Writes one file (creating the skill if new) as a new version, returned. */
  writeFile(name: string, file: SkillFile, by: Caller, note?: string): Promise<Skill>;
  submitFeedback(feedback: Feedback, by: Caller): Promise<{ id: string }>;
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

export type AgentStatus = "starting" | "working" | "waiting" | "review" | "done" | "stopped";

export interface Agent {
  id: string;
  name: string;
  role: string | null;
  /** The task id it was started on, or null. */
  task: string | null;
  status: AgentStatus;
  createdAt: string;
}

export interface NewAgent {
  name: string;
  role?: string;
  task?: string;
  brief: string;
}

export type AgentEvent =
  | { type: "status"; agentId: string; status: AgentStatus }
  | { type: "ended"; agentId: string; reason: string };

export interface Agents {
  create(agent: NewAgent): Promise<Agent>;
  get(id: string): Promise<Agent | undefined>;
  list(): Promise<Agent[]>;
  /** Delivers a message as the agent's next turn. */
  send(id: string, text: string, by: Caller): Promise<void>;
  /** Ends its session; its status becomes `stopped`. */
  stop(id: string): Promise<void>;
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
