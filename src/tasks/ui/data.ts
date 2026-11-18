import type { Api } from "../../ui/page.ts";

export interface Task {
  id: string;
  shortId: string;
  title: string;
  description: string;
  status: "backlog" | "in_progress" | "review" | "done" | "cancelled";
  dependsOn: string[];
  blockedBy: string[];
  subtasks: { id: string; title: string; status: string }[];
  criteria: { id: string; text: string; met: boolean }[];
  labels: string[];
  assignee: string | null;
  ready: boolean;
}
export interface Label {
  id: string;
  name: string;
  color: string;
}
export interface Entry {
  taskId: string;
  position: number;
  state: "queued" | "started" | "finished" | "dropped";
  note: string | null;
  agentName: string | null;
}
export interface Snapshot {
  tasks: Task[];
  labels: Label[];
  entries: Entry[];
}

export const isOpen = (t: Task) => t.status !== "done" && t.status !== "cancelled";

export async function load(api: Api): Promise<Snapshot> {
  const [t, l, q] = await Promise.all([
    api.get<{ tasks: Task[] }>("/api/tasks?maxResults=500"),
    api.get<{ labels: Label[] }>("/api/tasks/labels?maxResults=500"),
    api.get<{ entries: Entry[] }>("/api/queue"),
  ]);
  return { tasks: t.tasks, labels: l.labels, entries: q.entries };
}

/** The 1-based place of each queued task, by task id. */
export function places(entries: Entry[]): Map<string, { place: number; note: string | null }> {
  const queued = entries.filter((e) => e.state === "queued").sort((a, b) => a.position - b.position);
  return new Map(queued.map((e, i) => [e.taskId, { place: i + 1, note: e.note }]));
}

/** The brief an agent started from the page is given, as the queue gives one. */
export function briefFor(task: Task): string {
  const lines = [
    `Work on waypoint task ${task.shortId}: ${task.title}`,
    "",
    `Read it in full first: GetTask ${task.id} on the waypoint MCP server, with its comments.`,
  ];
  if (task.criteria.length) {
    lines.push("", "It is done when:");
    for (const c of task.criteria) lines.push(`- [${c.met ? "x" : " "}] ${c.id}: ${c.text}`);
  }
  lines.push("", "Move it to `in_progress` as you start. Mark each criterion met once you have seen it hold yourself.");
  return lines.join("\n");
}

export interface Outcome {
  ok: boolean;
  message: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Starts an implementer on the task now. Starts nothing if someone is on it; takes it out of the queue first. */
export async function start(api: Api, taskId: string): Promise<Outcome> {
  try {
    const { task } = await api.get<{ task: Task }>(`/api/tasks/${taskId}`);
    if (task.assignee) return { ok: false, message: `Not started: ${task.assignee} is already on ${task.shortId}.` };
    if (!isOpen(task)) return { ok: false, message: `Not started: ${task.shortId} is ${task.status}.` };
    if (task.blockedBy.length) return { ok: false, message: `Not started: ${task.shortId} is blocked by ${task.blockedBy.map((b) => b.slice(0, 8)).join(", ")}.` };
    const { entries } = await api.get<{ entries: Entry[] }>("/api/queue");
    if (entries.some((e) => e.taskId === task.id && e.state === "queued")) await api.send("DELETE", `/api/queue/${task.id}`);
    const agent = await api.send<{ name: string }>("POST", "/api/agents", { name: `impl-${task.shortId}`, role: "implementer", task: task.id, brief: briefFor(task) });
    return { ok: true, message: `Started ${agent.name} on ${task.shortId}.` };
  } catch (e) {
    return { ok: false, message: `Not started: ${msg(e)}` };
  }
}

export async function enqueue(api: Api, taskId: string): Promise<Outcome> {
  try {
    await api.send("POST", "/api/queue", { taskId });
    return { ok: true, message: "Queued." };
  } catch (e) {
    return { ok: false, message: `Not queued: ${msg(e)}` };
  }
}

export async function dequeue(api: Api, taskId: string): Promise<Outcome> {
  try {
    await api.send("DELETE", `/api/queue/${taskId}`);
    return { ok: true, message: "Taken out of the queue." };
  } catch (e) {
    return { ok: false, message: `Not dequeued: ${msg(e)}` };
  }
}
