import type { Agent, AgentStatus } from "../../contracts.ts";
import type { Api, Page } from "../../ui/page.ts";
import "./workers.css";
import { follow } from "./follow.ts";
import { renderMarkdown } from "./markdown.ts";

export interface Line {
  seq: number;
  at: string;
  kind: "message" | "agent" | "tool" | "result" | "notice";
  sender: string | null;
  text: string;
}
type Detail = Agent & { costUsd: number };

/** Waiting first: it is the one that needs the person. */
export const ORDER: AgentStatus[] = ["waiting", "working", "review", "idle", "done"];

export const byStatus = (a: Agent, b: Agent) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.createdAt.localeCompare(b.createdAt);
export const money = (usd: number) => `$${usd.toFixed(2)}`;

const alive = (root: Element) => () => root.isConnected;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function go(path: string): void {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

const taskLink = (doc: Document, task: string) => Object.assign(make(doc, "a", "task", `task ${task.slice(0, 8)}`), { href: `/items/${task.slice(0, 8)}` });

function card(doc: Document, a: Detail): HTMLElement {
  const c = make(doc, "a", `card ${a.status}`);
  c.href = `/workers/${a.name}`;
  const top = make(doc, "div", "top");
  top.append(make(doc, "strong", "title", a.title ?? a.name), make(doc, "span", `status ${a.status}`, a.status));
  const meta = make(doc, "div", "meta muted");
  meta.append(...[a.name, a.role, a.task ? `task ${a.task.slice(0, 8)}` : null, money(a.costUsd)].filter((x): x is string => !!x).map((t) => make(doc, "span", "", t)));
  c.append(top);
  if (a.headline) c.append(make(doc, "div", "headline", a.headline));
  c.append(meta);
  return c;
}

async function listPage(into: HTMLElement, api: Api): Promise<void> {
  const doc = into.ownerDocument;
  const head = make(doc, "div", "bar");
  const newBtn = make(doc, "button", "", "New agent");
  head.append(make(doc, "h1", "", "Workers"), newBtn);
  const form = newAgentForm(doc, api);
  form.hidden = true;
  newBtn.onclick = () => (form.hidden = !form.hidden);
  const open = make(doc, "div", "cards");
  const closed = make(doc, "details", "closed");
  const closedBody = make(doc, "div", "cards");
  closed.append(make(doc, "summary", "", "Closed"), closedBody);
  const error = make(doc, "p", "error");
  into.append(head, form, error, open, closed);

  const refresh = async () => {
    try {
      const { agents } = await api.get<{ agents: Agent[] }>("/api/agents");
      const all = await Promise.all(agents.map((a) => api.get<Detail>(`/api/agents/${a.id}`).catch(() => ({ ...a, costUsd: 0 }))));
      all.sort(byStatus);
      const isOpen = (a: Agent) => !a.closedAt;
      open.replaceChildren(...all.filter(isOpen).map((a) => card(doc, a)));
      if (!open.children.length) open.append(make(doc, "p", "muted", "No open agents."));
      const done = all.filter((a) => !isOpen(a));
      closed.hidden = !done.length;
      closed.querySelector("summary")!.textContent = `Closed (${done.length})`;
      closedBody.replaceChildren(...done.map((a) => card(doc, a)));
      error.textContent = "";
    } catch (e) {
      error.textContent = message(e);
    }
  };
  await refresh();
  let timer: ReturnType<typeof setTimeout> | undefined;
  void follow(
    () => "/api/agents/events",
    (e) => {
      if (e.event !== "agent") return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    },
    alive(open),
  );
}

function newAgentForm(doc: Document, api: Api): HTMLFormElement {
  const form = make(doc, "form", "new");
  const field = (label: string, input: HTMLElement) => {
    const l = make(doc, "label");
    l.append(make(doc, "span", "muted", label), input);
    return l;
  };
  const name = Object.assign(make(doc, "input"), { required: true, pattern: "[a-z0-9][a-z0-9\\-]{0,39}", placeholder: "lowercase-name" });
  // The role is chosen from the roles the app lists; where it lists none, it is typed.
  const roleBox = make(doc, "span", "role");
  let role = Object.assign(make(doc, "input"), { placeholder: "role (optional)" }) as HTMLInputElement | HTMLSelectElement;
  roleBox.append(role);
  void api.get<{ roles: { name: string }[] } | { name: string }[]>("/api/roles").then(
    (r) => {
      const list = Array.isArray(r) ? r : r.roles;
      if (!list?.length) return;
      const select = make(doc, "select");
      select.append(Object.assign(make(doc, "option"), { value: "", textContent: "No role" }), ...list.map((x) => Object.assign(make(doc, "option"), { value: x.name, textContent: x.name })));
      roleBox.replaceChildren(select);
      role = select;
    },
    () => {},
  );
  const brief = Object.assign(make(doc, "textarea"), { required: true, rows: 4, placeholder: "What it is to do" });
  const cap = make(doc, "select");
  cap.append(
    Object.assign(make(doc, "option"), { value: "", textContent: "Role's default" }),
    ...[["1", "1 · Haiku"], ["2", "2 · Sonnet"], ["3", "3 · Opus"]].map(([v, t]) => Object.assign(make(doc, "option"), { value: v, textContent: t })),
  );
  const error = make(doc, "p", "error");
  const submit = Object.assign(make(doc, "button", "", "Start agent"), { type: "submit" });
  form.append(field("Name", name), field("Role", roleBox), field("Brief", brief), field("Capability", cap), error, submit);
  form.onsubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const body: Record<string, unknown> = { name: name.value, brief: brief.value };
      if (role.value) body.role = role.value;
      if (cap.value) body.capability = Number(cap.value);
      const made = await api.send<Agent>("POST", "/api/agents", body);
      go(`/workers/${made.name}`);
    } catch (err) {
      error.textContent = message(err);
      submit.disabled = false;
    }
  };
  return form;
}

/** Draws transcript lines: messages and replies as markdown, runs of tool calls folded. */
export class Transcript {
  readonly root: HTMLElement;
  private fold: HTMLElement | null = null;
  private count = 0;
  last = 0;
  private doc: Document;
  constructor(doc: Document) {
    this.doc = doc;
    this.root = make(doc, "div", "transcript");
  }
  add(line: Line): void {
    if (line.seq <= this.last) return;
    this.last = line.seq;
    const d = this.doc;
    if (line.kind === "tool" || line.kind === "result") {
      if (!this.fold) {
        this.fold = make(d, "details", "tools");
        this.fold.append(make(d, "summary"));
        this.root.append(this.fold);
        this.count = 0;
      }
      if (line.kind === "tool") this.count++;
      this.fold.querySelector("summary")!.textContent = `${this.count} tool call${this.count === 1 ? "" : "s"}`;
      this.fold.append(make(d, "pre", line.kind, line.text));
      return;
    }
    this.fold = null;
    const box = make(d, "div", `line ${line.kind}`);
    if (line.kind === "message") box.append(make(d, "div", "who muted", line.sender ?? "message"));
    if (line.kind === "notice") box.textContent = line.text;
    else renderMarkdown(d, box, line.text);
    this.root.append(box);
  }
}

async function agentPage(into: HTMLElement, id: string, api: Api): Promise<void> {
  const doc = into.ownerDocument;
  let agent: Detail;
  try {
    agent = await api.get<Detail>(`/api/agents/${encodeURIComponent(id)}`);
    if (!agent.name) throw new Error(`no agent ${id}`);
  } catch (e) {
    into.append(make(doc, "h1", "", `Worker ${id}`), make(doc, "p", "error", message(e)));
    return;
  }
  const bar = make(doc, "div", "bar");
  const h1 = make(doc, "h1");
  const status = make(doc, "span");
  const info = make(doc, "div", "meta muted");
  const headline = make(doc, "div", "headline");
  const stop = make(doc, "button", "", "Stop");
  const close = make(doc, "button", "danger", "Close agent and task");
  const actions = make(doc, "div", "actions");
  actions.append(stop, close);
  bar.append(h1, status);
  const error = make(doc, "p", "error");
  const back = Object.assign(make(doc, "a", "muted", "← Workers"), { href: "/workers" });
  const show = (a: Detail) => {
    agent = { ...agent, ...a };
    h1.textContent = agent.title ?? agent.name;
    status.className = `status ${agent.status}`;
    status.textContent = agent.closedAt ? "closed" : agent.status;
    headline.textContent = agent.headline ?? "";
    info.replaceChildren(...[agent.name, agent.role].filter((x): x is string => !!x).map((t) => make(doc, "span", "", t)));
    if (agent.task) info.append(taskLink(doc, agent.task));
    info.append(make(doc, "span", "", money(agent.costUsd)));
  };
  show(agent);

  const transcript = new Transcript(doc);
  const form = make(doc, "form", "send");
  const box = Object.assign(make(doc, "textarea"), { rows: 3, placeholder: "Message this agent", required: true });
  const send = Object.assign(make(doc, "button", "", "Send"), { type: "submit" });
  form.append(box, send);
  into.append(back, bar, info, headline, actions, error, transcript.root, form);

  const near = () => scrollY + innerHeight >= document.documentElement.scrollHeight - 120;
  const add = (line: Line) => {
    const stick = near();
    transcript.add(line);
    if (stick) scrollTo(0, document.documentElement.scrollHeight);
  };
  const reload = () => api.get<Detail>(`/api/agents/${agent.id}`).then(show, () => {});
  void follow(
    () => `/api/agents/${agent.id}/transcript/stream?after=${transcript.last}`,
    (e) => {
      if (e.event === "line") add((JSON.parse(e.data) as { line: Line }).line);
      else if (e.event === "agent") void reload();
    },
    alive(transcript.root),
  );

  const run = async (fn: () => Promise<unknown>) => {
    error.textContent = "";
    try {
      await fn();
    } catch (e) {
      error.textContent = message(e);
    }
    await reload();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    void run(async () => {
      await api.send("POST", `/api/agents/${agent.id}/messages`, { text });
      box.value = "";
    });
  };
  box.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  };
  stop.onclick = () => void run(() => api.send("POST", `/api/agents/${agent.id}/stop`));
  close.onclick = () =>
    void run(async () => {
      // The task closes first: when it refuses, nothing else changes.
      if (agent.task) await api.send("PATCH", `/api/tasks/${agent.task}`, { status: "done" });
      await api.send("POST", `/api/agents/${agent.id}/close`);
    });
}

export const pages: Page[] = [
  { path: "/workers", nav: "Workers", render: (el, _p, api) => listPage(el, api) },
  { path: "/workers/:id", render: (el, { id }, api) => agentPage(el, id!, api) },
];
