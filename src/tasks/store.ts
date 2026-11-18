import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { changes, ConflictError, TaskSet, type HistoryEntry, type Task, type TaskInput } from "./domain.ts";
import { Labels, type Label } from "./labels.ts";

export const MIGRATIONS = [
  `CREATE TABLE tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL);
   CREATE TABLE labels (id TEXT PRIMARY KEY, record TEXT NOT NULL);
   CREATE TABLE task_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, record TEXT NOT NULL);
   CREATE INDEX task_history_task ON task_history (task_id, seq);
   CREATE TABLE task_comments (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, record TEXT NOT NULL);
   CREATE INDEX task_comments_task ON task_comments (task_id, seq);
   CREATE TABLE task_client_tokens (operation TEXT NOT NULL, token TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (operation, token));`,
];

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: string;
}

/** A request's task fields with its task and label references still as given. */
export type TaskRequest = TaskInput;

/**
 * Tasks, labels, history and comments in the app's database, each record its
 * JSON. SQLite calls here are synchronous, so each operation reads every task,
 * decides and writes in one transaction with nothing between.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private rows<T>(sql: string, ...params: string[]): T[] {
    return (this.db.prepare(sql).all(...params) as { record: string }[]).map((row) => JSON.parse(row.record) as T);
  }

  tasks(): TaskSet {
    return new TaskSet(this.rows<Task>("SELECT record FROM tasks ORDER BY rowid"));
  }

  labels(): Labels {
    return new Labels(this.rows<Label>("SELECT record FROM labels"));
  }

  private put(table: "tasks" | "labels", record: { id: string }) {
    this.db.prepare(`INSERT INTO ${table} (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record`).run(record.id, JSON.stringify(record));
  }

  private token(operation: string, token: string): string | undefined {
    return (this.db.prepare("SELECT result FROM task_client_tokens WHERE operation = ? AND token = ?").get(operation, token) as { result: string } | undefined)?.result;
  }

  private remember(operation: string, token: string | undefined, result: string) {
    if (token) this.db.prepare("INSERT INTO task_client_tokens (operation, token, result) VALUES (?, ?, ?)").run(operation, token, result);
  }

  private history(entry: HistoryEntry) {
    this.db.prepare("INSERT INTO task_history (task_id, record) VALUES (?, ?)").run(entry.taskId, JSON.stringify(entry));
  }

  private resolved(tasks: TaskSet, labels: Labels, input: TaskRequest): TaskInput {
    return { ...input, ...(input.dependsOn && { dependsOn: tasks.ids(input.dependsOn) }), ...(input.labels && { labels: labels.ids(input.labels) }) };
  }

  createTask(input: TaskRequest, actor: string, clientToken?: string): Task {
    return this.tx(() => {
      const tasks = this.tasks();
      const made = clientToken ? this.token("CreateTask", clientToken) : undefined;
      const first = made ? tasks.get(made) : undefined;
      if (first) return first;
      const now = new Date().toISOString();
      const task = tasks.apply(null, this.resolved(tasks, this.labels(), input), actor, now);
      tasks.check(null, task);
      this.put("tasks", task);
      this.history({ taskId: task.id, action: "created", changes: changes(null, task), actor, at: now });
      this.remember("CreateTask", clientToken, task.id);
      return task;
    });
  }

  /** The task before and after the write; equal when nothing changed. */
  updateTask(ref: string, input: TaskRequest, actor: string): { before: Task; after: Task } {
    return this.tx(() => {
      const tasks = this.tasks();
      const before = tasks.find(ref);
      const now = new Date().toISOString();
      const after = tasks.apply(before, this.resolved(tasks, this.labels(), input), actor, now);
      tasks.check(before, after);
      const changed = changes(before, after);
      if (!changed.length) return { before, after: before };
      this.put("tasks", after);
      this.history({ taskId: after.id, action: "updated", changes: changed, actor, at: now });
      return { before, after };
    });
  }

  taskHistory(ref: string): HistoryEntry[] {
    return this.rows<HistoryEntry>("SELECT record FROM task_history WHERE task_id = ? ORDER BY seq", this.tasks().find(ref).id);
  }

  comments(ref: string): Comment[] {
    return this.rows<Comment>("SELECT record FROM task_comments WHERE task_id = ? ORDER BY seq", this.tasks().find(ref).id);
  }

  createComment(ref: string, body: string, author: string, clientToken?: string): Comment {
    return this.tx(() => {
      const task = this.tasks().find(ref);
      const made = clientToken ? this.token("CreateComment", clientToken) : undefined;
      const first = made ? this.rows<Comment>("SELECT record FROM task_comments WHERE id = ?", made)[0] : undefined;
      if (first) return first;
      const comment: Comment = { id: randomUUID(), taskId: task.id, author, body, createdAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO task_comments (id, task_id, record) VALUES (?, ?, ?)").run(comment.id, task.id, JSON.stringify(comment));
      this.remember("CreateComment", clientToken, comment.id);
      return comment;
    });
  }

  createLabel(input: { name: string; color?: string; description?: string }, clientToken?: string): Label {
    return this.tx(() => {
      const labels = this.labels();
      const made = clientToken ? this.token("CreateLabel", clientToken) : undefined;
      const first = made ? labels.all().find((label) => label.id === made) : undefined;
      if (first) return first;
      const label = labels.create(input);
      this.put("labels", label);
      this.remember("CreateLabel", clientToken, label.id);
      return label;
    });
  }

  updateLabel(ref: string, patch: { name?: string; color?: string; description?: string }): Label {
    return this.tx(() => {
      const labels = this.labels();
      const next = labels.updated(labels.find(ref), patch);
      this.put("labels", next);
      return next;
    });
  }
}

export { ConflictError };
