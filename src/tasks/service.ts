import type { Caller, TaskEvent, TaskStatus } from "../contracts.ts";
import type { Context } from "../module.ts";
import { CLOSED, ConflictError, ValidationError, type Task } from "./domain.ts";
import type { Label } from "./labels.ts";
import { Store, type Comment, type TaskRequest } from "./store.ts";

export type ListFilter = {
  status?: TaskStatus;
  ready?: "true" | "false" | boolean;
  label?: string;
  assignee?: string;
  manager?: string;
  dependsOn?: string;
  q?: string;
  includeCancelled?: "true" | "false" | boolean;
};

const DEFAULT_PAGE = 100;

/** One page of `items` from the offset `nextToken` encodes, and the token for the next. */
export function page<T>(items: T[], maxResults?: number, nextToken?: string): { items: T[]; nextToken: string | null } {
  let from = 0;
  if (nextToken !== undefined) {
    from = Number(Buffer.from(nextToken, "base64url").toString("utf8"));
    if (!Number.isInteger(from) || from < 0) throw new ValidationError("nextToken is not one this app gave");
  }
  const end = from + (maxResults ?? DEFAULT_PAGE);
  return { items: items.slice(from, end), nextToken: end < items.length ? Buffer.from(String(end)).toString("base64url") : null };
}

/** Everything the routes, tools and the `Tasks` interface do with tasks, in one place. */
export class TaskOps {
  readonly store: Store;
  private listeners = new Set<(event: TaskEvent) => void>();

  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.store = new Store(ctx.db);
  }

  onEvent(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Who a write is from: `person`, or the agent's name (its id if the agents module doesn't know it). */
  async actor(caller: Caller): Promise<string> {
    if (caller.kind === "person") return "person";
    return (await this.ctx.services.agents?.get(caller.agentId))?.name ?? caller.agentId;
  }

  view(task: Task) {
    return this.store.tasks().view(task);
  }

  getTask(ref: string) {
    const tasks = this.store.tasks();
    return tasks.view(tasks.find(ref));
  }

  list(f: ListFilter = {}) {
    const tasks = this.store.tasks();
    const labelRef = f.label?.toLowerCase();
    const label = f.label === undefined ? null : (this.store.labels().all().find((l) => l.id === f.label || l.name.toLowerCase() === labelRef)?.id ?? "");
    const dep = f.dependsOn === undefined ? null : tasks.find(f.dependsOn).id;
    const text = f.q?.toLowerCase();
    const on = (v: unknown) => v === true || v === "true";
    return tasks
      .all()
      .map((t) => tasks.view(t))
      .filter((t) => (f.status ? t.status === f.status : t.status !== "cancelled" || on(f.includeCancelled)))
      .filter((t) => f.ready === undefined || t.ready === on(f.ready))
      .filter((t) => label === null || t.labels.includes(label))
      .filter((t) => f.assignee === undefined || t.assignee === (f.assignee === "none" ? null : f.assignee))
      .filter((t) => f.manager === undefined || t.manager === (f.manager === "none" ? null : f.manager))
      .filter((t) => dep === null || t.dependsOn.includes(dep))
      .filter((t) => text === undefined || t.title.toLowerCase().includes(text) || t.description.toLowerCase().includes(text));
  }

  create(input: TaskRequest & { clientToken?: string }, actor: string) {
    const { clientToken, ...fields } = input;
    return this.view(this.store.createTask(fields, actor, clientToken));
  }

  update(ref: string, input: TaskRequest, actor: string) {
    const { before, after } = this.store.updateTask(ref, input, actor);
    if (!CLOSED.includes(before.status) && CLOSED.includes(after.status)) {
      for (const l of [...this.listeners]) {
        try {
          l({ type: "closed", taskId: after.id, status: after.status as "done" | "cancelled" });
        } catch {
          // A listener's failure is its own.
        }
      }
    }
    return this.view(after);
  }

  comment(ref: string, body: string, author: string, clientToken?: string): Comment {
    return this.store.createComment(ref, body, author, clientToken);
  }

  label(ref: string): Label {
    return this.store.labels().find(ref);
  }
}

export { ConflictError };
