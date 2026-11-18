import type { Api } from "../../ui/page.ts";
import { dequeue, enqueue, isOpen, start, type Outcome, type Task } from "./data.ts";
import { h } from "./dom.ts";

/** Start, Queue and Dequeue for one task, with a line saying what happened. `refresh` redraws the page in place. */
export function actions(api: Api, task: Task, queued: boolean, refresh: () => Promise<void>): HTMLElement {
  const box = h("div", { class: "actions" });
  const say = h("span", { class: "say", role: "status" });
  const run = (label: string, title: string, fn: () => Promise<Outcome>) =>
    h("button", {
      type: "button",
      textContent: label,
      title,
      onclick: async (ev: Event) => {
        const btn = ev.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        const out = await fn();
        say.textContent = out.message;
        say.className = out.ok ? "say" : "say bad";
        await refresh();
        // the redraw replaces this box, so keep the message where the person is looking
        const fresh = document.querySelector(`[data-task="${task.id}"] .say`);
        if (fresh) {
          fresh.textContent = out.message;
          fresh.className = out.ok ? "say" : "say bad";
        }
      },
    });
  if (isOpen(task)) {
    box.append(run("Start", "Start an agent on it now", () => start(api, task.id)));
    box.append(queued ? run("Dequeue", "Take it out of the queue", () => dequeue(api, task.id)) : run("Queue", "Start an agent when it is ready and there is room", () => enqueue(api, task.id)));
  }
  box.append(say);
  return box;
}
