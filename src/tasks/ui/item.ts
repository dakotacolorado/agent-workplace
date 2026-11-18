import type { Api } from "../../ui/page.ts";
import { actions } from "./actions.ts";
import { load, places, type Task } from "./data.ts";
import { h, markdown } from "./dom.ts";
import "./work.css";

interface Comment { id: string; author: string; body: string; createdAt: string }
interface Change { field: string; from: unknown; to: unknown }
interface History { action: string; changes: Change[]; actor: string | null; at: string }

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export async function renderItem(into: HTMLElement, id: string, api: Api): Promise<void> {
  const draw = async () => {
    const [snap, { task }, { comments }, { entries: history }] = await Promise.all([
      load(api),
      api.get<{ task: Task }>(`/api/tasks/${id}`),
      api.get<{ comments: Comment[] }>(`/api/tasks/${id}/comments?maxResults=500`),
      api.get<{ entries: History[] }>(`/api/tasks/${id}/history?maxResults=500`),
    ]);
    const byId = new Map(snap.tasks.map((t) => [t.id, t]));
    const place = places(snap.entries).get(task.id);
    const labels = task.labels.map((l) => snap.labels.find((x) => x.id === l)?.name).filter(Boolean) as string[];
    const link = (tid: string) => {
      const t = byId.get(tid);
      return h("a", { href: `/items/${t?.shortId ?? tid.slice(0, 8)}` }, `${t?.shortId ?? tid.slice(0, 8)} ${t?.title ?? ""}`);
    };
    const box = h("textarea", { rows: 3, placeholder: "Comment (Markdown)", "aria-label": "Comment" });
    const say = h("p", { class: "say bad", role: "alert" });
    const form = h("form", { class: "comment-form" }, box, say, h("button", { type: "submit", textContent: "Comment" }));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!box.value.trim()) return;
      try {
        await api.send("POST", `/api/tasks/${task.id}/comments`, { body: box.value });
        await draw();
      } catch (e) {
        say.textContent = e instanceof Error ? e.message : String(e);
      }
    });

    into.replaceChildren(
      h(
        "div",
        { "data-task": task.id },
        h("p", { class: "muted" }, h("a", { href: "/work" }, "← Work")),
        h("h1", {}, task.title),
        h(
          "div",
          { class: "meta" },
          h("span", { class: `chip status-${task.status}` }, task.status.replace("_", " ")),
          task.blockedBy.length ? h("span", { class: "chip blocked" }, `blocked by ${task.blockedBy.map((b) => byId.get(b)?.shortId ?? b.slice(0, 8)).join(", ")}`) : task.ready ? h("span", { class: "chip ready" }, "ready") : null,
          place ? h("span", { class: "chip queued", title: place.note ?? "" }, `queue place ${place.place}`, place.note ? h("span", { class: "muted" }, ` (${place.note})`) : null) : null,
          task.assignee ? (task.assignee === "person" ? h("span", { class: "chip" }, "person") : h("a", { class: "chip agent", href: `/workers/${task.assignee}` }, task.assignee)) : null,
          ...labels.map((n) => h("span", { class: "chip label" }, n)),
          h("span", { class: "muted id" }, task.shortId),
        ),
        actions(api, task, !!place, draw),
        h("h2", {}, "Description"),
        task.description ? markdown(task.description) : h("p", { class: "muted" }, "None."),
        h("h2", {}, "Criteria"),
        task.criteria.length ? h("ul", { class: "criteria" }, ...task.criteria.map((c) => h("li", { class: c.met ? "met" : "" }, h("span", { class: "box", "aria-label": c.met ? "met" : "not met" }, c.met ? "✓" : "○"), ` ${c.id}: ${c.text}`))) : h("p", { class: "muted" }, "None."),
        h("h2", {}, "Subtasks"),
        task.subtasks.length ? h("ul", {}, ...task.subtasks.map((s) => h("li", {}, `${s.title} `, h("span", { class: "muted" }, s.status.replace("_", " "))))) : h("p", { class: "muted" }, "None."),
        h("h2", {}, "Depends on"),
        task.dependsOn.length ? h("ul", {}, ...task.dependsOn.map((d) => h("li", {}, link(d), " ", h("span", { class: "muted" }, byId.get(d)?.status.replace("_", " ") ?? "")))) : h("p", { class: "muted" }, "Nothing."),
        h("h2", {}, "Comments"),
        ...(comments.length ? comments.map((c) => h("div", { class: "comment" }, h("div", { class: "muted" }, `${c.author} · ${when(c.createdAt)}`), markdown(c.body))) : [h("p", { class: "muted" }, "None.")]),
        form,
        h("h2", {}, "History"),
        h("ul", { class: "history" }, ...history.map((e) => h("li", {}, h("span", { class: "muted" }, `${when(e.at)} ${e.actor ?? ""} ${e.action}`), e.action === "updated" ? ` ${e.changes.filter((c) => c.field !== "description").map((c) => `${c.field}: ${show(c.from)} → ${show(c.to)}`).join("; ")}` : ""))),
      ),
    );
  };
  await draw();
}
