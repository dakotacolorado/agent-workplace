import type { Api } from "../../ui/page.ts";
import { actions } from "./actions.ts";
import { isOpen, load, places, type Snapshot, type Task } from "./data.ts";
import { h } from "./dom.ts";
import { newTaskForm } from "./form.ts";
import "./work.css";

const STATUSES = ["open", "backlog", "in_progress", "review"] as const;

export async function renderWork(into: HTMLElement, api: Api): Promise<void> {
  let snap = await load(api);
  const filters = { status: "open", label: "" };
  const list = h("div", { class: "tasks" });
  const formBox = h("div");

  const statusSel = h("select", { "aria-label": "Status", onchange: () => ((filters.status = statusSel.value), draw()) }, ...STATUSES.map((s) => h("option", { value: s, textContent: s === "open" ? "any open status" : s.replace("_", " ") })));
  const labelSel = h("select", { "aria-label": "Label", onchange: () => ((filters.label = labelSel.value), draw()) });
  const drawLabels = () => {
    labelSel.replaceChildren(h("option", { value: "", textContent: "any label" }), ...snap.labels.map((l) => h("option", { value: l.id, textContent: l.name })));
    labelSel.value = filters.label;
  };

  const refresh = async () => {
    snap = await load(api);
    drawLabels();
    draw();
  };

  const row = (t: Task, s: Snapshot, queuePlaces: ReturnType<typeof places>) => {
    const byId = new Map(s.tasks.map((x) => [x.id, x]));
    const place = queuePlaces.get(t.id);
    const labels = t.labels.map((id) => s.labels.find((l) => l.id === id)?.name).filter(Boolean) as string[];
    const readiness = t.blockedBy.length
      ? h("span", { class: "chip blocked" }, "blocked by ", ...t.blockedBy.flatMap((id, i) => [i ? ", " : "", h("a", { href: `/items/${byId.get(id)?.shortId ?? id.slice(0, 8)}` }, byId.get(id)?.shortId ?? id.slice(0, 8))]))
      : t.ready
        ? h("span", { class: "chip ready" }, "ready")
        : null;
    return h(
      "article",
      { class: "task", "data-task": t.id },
      h("div", { class: "top" }, h("a", { class: "title", href: `/items/${t.shortId}` }, t.title), h("span", { class: "muted id" }, t.shortId)),
      h(
        "div",
        { class: "meta" },
        h("span", { class: `chip status-${t.status}` }, t.status.replace("_", " ")),
        readiness,
        place ? h("span", { class: "chip queued", title: place.note ?? "" }, `queue place ${place.place}`, place.note ? h("span", { class: "muted" }, ` (${place.note})`) : null) : null,
        t.assignee ? (t.assignee === "person" ? h("span", { class: "chip" }, "person") : h("a", { class: "chip agent", href: `/workers/${t.assignee}` }, t.assignee)) : null,
        ...labels.map((n) => h("span", { class: "chip label" }, n)),
      ),
      actions(api, t, !!place, refresh),
    );
  };

  const draw = () => {
    const qp = places(snap.entries);
    const shown = snap.tasks.filter(isOpen).filter((t) => (filters.status === "open" || t.status === filters.status) && (!filters.label || t.labels.includes(filters.label)));
    list.replaceChildren(
      h("p", { class: "muted count" }, `${shown.length} open task${shown.length === 1 ? "" : "s"}`),
      ...(shown.length ? shown.map((t) => row(t, snap, qp)) : [h("p", { class: "muted" }, "No open tasks match.")]),
    );
  };

  const toggle = h("button", { type: "button", textContent: "New task", onclick: () => {
    if (formBox.childElementCount) return formBox.replaceChildren();
    formBox.append(newTaskForm(api, snap, async (created) => {
      formBox.replaceChildren();
      await refresh();
      const note = document.querySelector(`[data-task="${created.id}"]`);
      note?.scrollIntoView?.();
    }, () => formBox.replaceChildren()));
  } });

  into.replaceChildren(h("div", { class: "head" }, h("h1", {}, "Work"), toggle), formBox, h("div", { class: "filters" }, statusSel, labelSel), list);
  drawLabels();
  draw();
}
