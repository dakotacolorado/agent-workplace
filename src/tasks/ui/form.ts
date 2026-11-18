import type { Api } from "../../ui/page.ts";
import { isOpen, type Snapshot, type Task } from "./data.ts";
import { h } from "./dom.ts";

/** The New task form: title, description, labels, criteria (one per line) and what it depends on. */
export function newTaskForm(api: Api, snap: Snapshot, created: (t: Task) => void | Promise<void>, cancel: () => void): HTMLElement {
  const title = h("input", { name: "title", required: true, placeholder: "Title" });
  const description = h("textarea", { name: "description", rows: 4, placeholder: "Description (Markdown)" });
  const labels = h("input", { name: "labels", placeholder: "Labels, separated by commas", list: "label-names" });
  const names = h("datalist", { id: "label-names" }, ...snap.labels.map((l) => h("option", { value: l.name })));
  const criteria = h("textarea", { name: "criteria", rows: 3, placeholder: "Criteria, one per line" });
  const deps = h("select", { name: "dependsOn", multiple: true, size: 5, "aria-label": "Depends on" }, ...snap.tasks.filter(isOpen).map((t) => h("option", { value: t.id, textContent: `${t.shortId} ${t.title}` })));
  const say = h("p", { class: "say bad", role: "alert" });
  const form = h(
    "form",
    { class: "new-task" },
    h("h2", {}, "New task"),
    h("label", {}, "Title", title),
    h("label", {}, "Description", description),
    h("label", {}, "Labels", labels, names),
    h("label", {}, "Criteria", criteria),
    h("label", {}, "Depends on", deps),
    say,
    h("div", { class: "actions" }, h("button", { type: "submit", textContent: "Create" }), h("button", { type: "button", class: "plain", textContent: "Cancel", onclick: cancel })),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    say.textContent = "";
    try {
      const wanted = labels.value.split(",").map((s) => s.trim()).filter(Boolean);
      const have = new Set(snap.labels.map((l) => l.name.toLowerCase()));
      for (const name of wanted) if (!have.has(name.toLowerCase())) await api.send("POST", "/api/tasks/labels", { name });
      const { task } = await api.send<{ task: Task }>("POST", "/api/tasks", {
        title: title.value.trim(),
        description: description.value,
        labels: wanted,
        criteria: criteria.value.split("\n").map((s) => s.trim()).filter(Boolean).map((text) => ({ text })),
        dependsOn: [...deps.selectedOptions].map((o) => o.value),
      });
      await created(task);
    } catch (e) {
      say.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  return form;
}
