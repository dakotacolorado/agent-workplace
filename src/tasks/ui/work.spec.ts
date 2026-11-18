// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { Api } from "../../ui/page.ts";
import { pages } from "./tasks.ts";

const mk = (id: string, over: Record<string, unknown> = {}) => ({ id: `${id}0000000-0000`, shortId: `${id}000000`, title: `Task ${id}`, description: "", status: "backlog", dependsOn: [], blockedBy: [], subtasks: [], criteria: [], labels: [], assignee: null, ready: true, ...over });

function fake() {
  const calls: string[] = [];
  const state: { tasks: ReturnType<typeof mk>[]; entries: unknown[] } = {
    tasks: [mk("a"), mk("b", { dependsOn: ["a0000000-0000"], blockedBy: ["a0000000-0000"], ready: false }), mk("c", { assignee: "impl-c", status: "in_progress", ready: false })],
    entries: [{ taskId: "b0000000-0000", position: 1, state: "queued", note: "waits on a", agentName: null }],
  };
  const api: Api = {
    async get(path: string) {
      const p = path.split("?")[0]!;
      if (p === "/api/tasks") return { tasks: state.tasks } as never;
      if (p === "/api/tasks/labels") return { labels: [] } as never;
      if (p === "/api/queue") return { entries: state.entries } as never;
      const m = /^\/api\/tasks\/([^/]+)(\/comments|\/history)?$/.exec(p)!;
      if (m[2] === "/comments") return { comments: [{ id: "1", author: "person", body: "hello **there**", createdAt: "2026-01-01T00:00:00Z" }] } as never;
      if (m[2] === "/history") return { entries: [] } as never;
      return { task: state.tasks.find((t) => t.id.startsWith(m[1]!)) } as never;
    },
    async send(method, path, body) {
      calls.push(`${method} ${path}${body === undefined ? "" : " " + JSON.stringify(body)}`);
      if (method === "POST" && path === "/api/agents") {
        const b = body as { task: string; name: string };
        const t = state.tasks.find((x) => x.id === b.task)!;
        (t as { assignee: string | null }).assignee = b.name;
        return { name: b.name } as never;
      }
      if (method === "POST" && path === "/api/tasks") return { task: mk("n") } as never;
      return {} as never;
    },
  };
  return { api, calls, state };
}

const flush = () => new Promise((r) => setTimeout(r, 10));
const click = (el: Element | null | undefined) => (el as HTMLElement).click();
const card = (sid: string) => document.querySelector(`[data-task^="${sid}"]`)!;
const button = (root: Element, label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label);

describe("the Work page", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  const main = () => document.body.appendChild(document.createElement("main"));

  it("lists open tasks with status, ready or blocked-by, agent and queue place", async () => {
    const { api } = fake();
    const el = main();
    await pages[0]!.render(el, {}, api);
    expect(el.querySelectorAll("article").length).toBe(3);
    expect(card("a").textContent).toContain("ready");
    expect(card("b").textContent).toContain("blocked by a000000");
    expect(card("b").textContent).toContain("queue place 1");
    expect(card("c").querySelector("a.agent")?.getAttribute("href")).toBe("/workers/impl-c");
    const status = el.querySelector("select[aria-label=Status]") as HTMLSelectElement;
    status.value = "in_progress";
    status.dispatchEvent(new Event("change"));
    expect(el.querySelectorAll("article").length).toBe(1);
  });

  it("with no open tasks at all, hides the filters and says to start a planner on Workers", async () => {
    const { api, state } = fake();
    state.tasks.length = 0;
    state.entries.length = 0;
    const el = main();
    await pages[0]!.render(el, {}, api);
    expect((el.querySelector(".filters") as HTMLElement).hidden).toBe(true);
    expect(el.textContent).toContain("No tasks yet. Go to Workers, start a planner");
    expect(el.querySelector('a[href="/workers"]')?.textContent).toBe("Workers");
    expect(el.textContent).not.toContain("No open tasks match.");
  });

  it("with only closed tasks, treats the app as having none open", async () => {
    const { api, state } = fake();
    for (const t of state.tasks) t.status = "done";
    const el = main();
    await pages[0]!.render(el, {}, api);
    expect((el.querySelector(".filters") as HTMLElement).hidden).toBe(true);
    expect(el.textContent).toContain("No tasks yet.");
  });

  it("keeps the filters and says 'No open tasks match.' when a filter hides every task", async () => {
    const { api } = fake();
    const el = main();
    await pages[0]!.render(el, {}, api);
    expect((el.querySelector(".filters") as HTMLElement).hidden).toBe(false);
    const status = el.querySelector("select[aria-label=Status]") as HTMLSelectElement;
    status.value = "review";
    status.dispatchEvent(new Event("change"));
    expect(el.querySelectorAll("article").length).toBe(0);
    expect(el.textContent).toContain("No open tasks match.");
    expect(el.textContent).not.toContain("No tasks yet.");
  });

  it("explains Start and Queue in a hint and in each button's title", async () => {
    const { api } = fake();
    const el = main();
    await pages[0]!.render(el, {}, api);
    expect(el.querySelector(".hint")?.textContent).toContain("Start runs an agent on a task now");
    expect(el.querySelector(".hint")?.textContent).toContain("Queue starts one when the task is ready and there is room");
    expect(button(card("a"), "Start")?.title).toBe("Start an agent on it now");
    expect(button(card("a"), "Queue")?.title).toBe("Start an agent when it is ready and there is room");
    expect(button(card("b"), "Dequeue")?.title).toBe("Take it out of the queue");
  });

  it("starts in place, taking a queued task out of the queue first", async () => {
    const { api, calls, state } = fake();
    state.tasks[1]!.blockedBy = [];
    const el = main();
    await pages[0]!.render(el, {}, api);
    click(button(card("b"), "Start"));
    await flush();
    expect(calls[0]).toMatch(/^DELETE \/api\/queue\/b0000000/);
    expect(calls[1]).toMatch(/^POST \/api\/agents .*impl-b000000/);
    expect(card("b").querySelector(".say")?.textContent).toContain("Started impl-b000000");
    expect(location.pathname).not.toContain("items");
  });

  it("starts nothing on a task someone is on, and says who", async () => {
    const { api, calls } = fake();
    const el = main();
    await pages[0]!.render(el, {}, api);
    click(button(card("c"), "Start"));
    await flush();
    expect(calls).toEqual([]);
    expect(card("c").querySelector(".say")?.textContent).toContain("impl-c is already on");
  });

  it("queues and dequeues", async () => {
    const { api, calls } = fake();
    const el = main();
    await pages[0]!.render(el, {}, api);
    click(button(card("a"), "Queue"));
    await flush();
    click(button(card("b"), "Dequeue"));
    await flush();
    expect(calls).toEqual(['POST /api/queue {"taskId":"a0000000-0000"}', "DELETE /api/queue/b0000000-0000"]);
  });

  it("creates a task with criteria and dependencies", async () => {
    const { api, calls } = fake();
    const el = main();
    await pages[0]!.render(el, {}, api);
    click(button(el, "New task"));
    const form = el.querySelector("form")!;
    (form.querySelector("[name=title]") as HTMLInputElement).value = "New one";
    (form.querySelector("[name=criteria]") as HTMLTextAreaElement).value = "first\nsecond";
    (form.querySelector("select[name=dependsOn]") as HTMLSelectElement).options[0]!.selected = true;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(calls[0]).toContain('"title":"New one"');
    expect(calls[0]).toContain('"criteria":[{"text":"first"},{"text":"second"}]');
    expect(calls[0]).toContain('"dependsOn":["a0000000-0000"]');
  });

  it("shows a task's page with its parts and starts from it, staying there", async () => {
    const { api, calls } = fake();
    const el = main();
    await pages[1]!.render(el, { id: "a000000" }, api);
    expect(el.querySelector("h1")?.textContent).toBe("Task a");
    for (const h2 of ["Description", "Criteria", "Subtasks", "Depends on", "Comments", "History"]) expect(el.textContent).toContain(h2);
    expect(el.querySelector(".comment strong")?.textContent).toBe("there");
    click(button(el, "Start"));
    await flush();
    expect(calls.some((c) => c.startsWith("POST /api/agents"))).toBe(true);
    expect(el.querySelector("h1")?.textContent).toBe("Task a");
    expect(el.querySelector("a.agent")?.getAttribute("href")).toBe("/workers/impl-a000000");
  });
});
