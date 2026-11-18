// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { Api } from "../../ui/page.ts";
import { byStatus, pages, Transcript } from "./agents.ts";
import { renderMarkdown } from "./markdown.ts";

const agent = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`, name, role: "implementer", task: null, brief: "b", capability: 2, status, headline: null, title: null,
  live: false, queued: false, limitedUntil: null, closedAt: null, createdAt: `2026-01-0${name.length}`, updatedAt: "", costUsd: 1.5, ...extra,
});

function fakeApi(agents: ReturnType<typeof agent>[], calls: [string, string, unknown][] = [], failTask = false, roles: string[] | null = null): Api {
  return {
    async get(path: string) {
      if (path === "/api/agents") return { agents } as never;
      if (path === "/api/roles") {
        if (!roles) throw new Error("no roles");
        return { roles: roles.map((name) => ({ name })) } as never;
      }
      const a = agents.find((x) => path.endsWith(`/${x.id}`) || path.endsWith(`/${x.name}`));
      if (!a) throw new Error("no such agent");
      return a as never;
    },
    async send(method, path, body) {
      calls.push([method, path, body]);
      if (failTask && path.startsWith("/api/tasks/")) throw new Error("criterion c1 is not met");
      return {} as never;
    },
  };
}
const render = async (path: string, params: Record<string, string>, api: Api) => {
  const into = document.createElement("main");
  document.body.replaceChildren(into);
  await pages.find((p) => p.path === path)!.render(into, params, api);
  return into;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Workers page", () => {
  beforeEach(() => {
    globalThis.fetch = (() => new Promise(() => {})) as never;
  });

  it("sorts waiting first, then working, review, idle, done", () => {
    const order = ["done", "idle", "waiting", "review", "working"].map((s) => agent(s, s)).sort((a, b) => byStatus(a as never, b as never)).map((a) => a.status);
    expect(order).toEqual(["waiting", "working", "review", "idle", "done"]);
  });

  it("lists open agents with title, headline, role, task, status and cost, and closed ones apart", async () => {
    const into = await render("/workers", {}, fakeApi([
      agent("a", "working", { title: "Fix login", headline: "reading code", task: "12345678-aaaa" }),
      agent("bb", "waiting"),
      agent("ccc", "done", { closedAt: "2026-01-02" }),
    ]));
    const cards = [...into.querySelectorAll(".cards")];
    const open = [...cards[0]!.querySelectorAll(".card")];
    expect(open.map((c) => c.querySelector(".status")?.textContent)).toEqual(["waiting", "working"]);
    expect(open[1]!.textContent).toContain("Fix login");
    expect(open[1]!.textContent).toContain("reading code");
    expect(open[1]!.textContent).toContain("implementer");
    expect(open[1]!.textContent).toContain("task 12345678");
    expect(open[1]!.textContent).toContain("$1.50");
    expect(cards[1]!.textContent).toContain("ccc");
  });

  it("starts an agent from the New agent form", async () => {
    const calls: [string, string, unknown][] = [];
    const into = await render("/workers", {}, fakeApi([], calls));
    (into.querySelector("form.new input") as HTMLInputElement).value = "helper";
    (into.querySelector("form.new textarea") as HTMLTextAreaElement).value = "do it";
    into.querySelector("form.new")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(calls).toEqual([["POST", "/api/agents", { name: "helper", brief: "do it" }]]);
  });

  it("toggles the form with New agent, open only when there are no agents", async () => {
    const empty = await render("/workers", {}, fakeApi([]));
    const form = empty.querySelector("form.new") as HTMLFormElement;
    expect(form.hidden).toBe(false);
    (empty.querySelector(".bar button") as HTMLButtonElement).click();
    expect(form.hidden).toBe(true);
    (empty.querySelector(".bar button") as HTMLButtonElement).click();
    expect(form.hidden).toBe(false);
    const some = await render("/workers", {}, fakeApi([agent("a", "working")]));
    expect((some.querySelector("form.new") as HTMLFormElement).hidden).toBe(true);
  });

  it("defaults the role to planner, names a blank name <role>-<n>, and explains a bad name", async () => {
    const calls: [string, string, unknown][] = [];
    const into = await render("/workers", {}, fakeApi([agent("planner-1", "working")], calls, false, ["implementer", "planner"]));
    await tick();
    const select = into.querySelector("form.new select") as HTMLSelectElement;
    expect(select.value).toBe("planner");
    const name = into.querySelector("form.new input") as HTMLInputElement;
    expect(name.placeholder).toContain("planner-2");
    expect(into.querySelector("form.new label span")!.textContent).toBe("Name");
    expect(into.querySelector("form.new textarea")!.closest("label")!.textContent).toContain("What do you want done?");
    expect((into.querySelector("form.new textarea") as HTMLTextAreaElement).placeholder).toContain("owner/repo");
    name.value = "My Planner";
    name.dispatchEvent(new Event("input"));
    expect(name.validationMessage).toContain("lowercase letters, digits and hyphens");
    name.value = "";
    name.dispatchEvent(new Event("input"));
    (into.querySelector("form.new textarea") as HTMLTextAreaElement).value = "do it";
    into.querySelector("form.new")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(calls).toEqual([["POST", "/api/agents", { name: "planner-2", brief: "do it", role: "planner" }]]);
  });

  it("sends a message, stops, and closes the task before the agent", async () => {
    const calls: [string, string, unknown][] = [];
    const into = await render("/workers/:id", { id: "a" }, fakeApi([agent("a", "waiting", { task: "t1" })], calls));
    const box = into.querySelector("form.send textarea") as HTMLTextAreaElement;
    box.value = "hello";
    into.querySelector("form.send")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    const buttons = [...into.querySelectorAll(".actions button")] as HTMLButtonElement[];
    buttons[0]!.click();
    await tick();
    buttons[1]!.click();
    await tick();
    expect(calls).toEqual([
      ["POST", "/api/agents/id-a/messages", { text: "hello" }],
      ["POST", "/api/agents/id-a/stop", undefined],
      ["PATCH", "/api/tasks/t1", { status: "done" }],
      ["POST", "/api/agents/id-a/close", undefined],
    ]);
  });

  it("shows Stop only while the session is live", async () => {
    const idle = await render("/workers/:id", { id: "a" }, fakeApi([agent("a", "done")]));
    expect((idle.querySelector(".actions button") as HTMLButtonElement).hidden).toBe(true);
    const live = await render("/workers/:id", { id: "a" }, fakeApi([agent("a", "working", { live: true })]));
    expect((live.querySelector(".actions button") as HTMLButtonElement).hidden).toBe(false);
  });

  it("labels the close button for a task only when the agent has one", async () => {
    const planner = await render("/workers/:id", { id: "a" }, fakeApi([agent("a", "done")]));
    expect((planner.querySelectorAll(".actions button")[1] as HTMLButtonElement).textContent).toBe("Close agent");
    const worker = await render("/workers/:id", { id: "a" }, fakeApi([agent("a", "done", { task: "t1" })]));
    expect((worker.querySelectorAll(".actions button")[1] as HTMLButtonElement).textContent).toBe("Close agent and task");
  });

  it("changes nothing and shows why when the task refuses to close", async () => {
    const calls: [string, string, unknown][] = [];
    const into = await render("/workers/:id", { id: "a" }, fakeApi([agent("a", "waiting", { task: "t1" })], calls, true));
    (into.querySelectorAll(".actions button")[1] as HTMLButtonElement).click();
    await tick();
    expect(calls.map((c) => c[1])).toEqual(["/api/tasks/t1"]);
    expect(into.querySelector(".error")?.textContent).toBe("criterion c1 is not met");
  });
});

describe("Transcript", () => {
  it("renders markdown, folds runs of tool calls, and takes each line once", () => {
    const t = new Transcript(document);
    const line = (seq: number, kind: "message" | "agent" | "tool" | "result", text: string) => ({ seq, at: "", kind, sender: "person", text });
    t.add(line(1, "message", "hi"));
    t.add(line(2, "agent", "**bold** and `code`\n\n- one\n- two"));
    t.add(line(3, "tool", "Bash {}"));
    t.add(line(4, "result", "ok"));
    t.add(line(5, "tool", "Read {}"));
    t.add(line(5, "tool", "Read {}"));
    expect(t.root.querySelectorAll("strong, li").length).toBe(3);
    expect(t.root.querySelectorAll("details").length).toBe(1);
    expect(t.root.querySelector("summary")?.textContent).toBe("2 tool calls");
    expect(t.last).toBe(5);
  });

  it("never takes text as HTML", () => {
    const div = document.createElement("div");
    renderMarkdown(document, div, "<img src=x onerror=alert(1)> [x](javascript:alert(1))");
    expect(div.querySelector("img, a")).toBeNull();
  });
});
