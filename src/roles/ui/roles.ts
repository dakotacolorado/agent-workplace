import { failure, h, skillHref } from "../../skills/ui/dom.ts";
import type { Api, Page } from "../../ui/page.ts";

interface Role {
  name: string;
  description: string;
  skills: string[];
  priority: number;
  capability: 1 | 2 | 3;
  brief: string;
  whenDone?: "stop" | "keep";
  instructions?: string;
}

const MODELS = { 1: "easy", 2: "medium", 3: "hard" } as const;

/** Roles live under Skills. Listed after the skills module's pages, `/skills/roles` wins over `/skills/:name` by being exact. */
async function roles(into: HTMLElement, _p: Record<string, string>, api: Api) {
  const error = h("p", { class: "error", hidden: true });
  const formBox = h("div", null);
  const body = h("div", null);
  const newRole = h("button", { type: "button", id: "new-role", onclick: () => open(undefined) }, "New role");
  into.replaceChildren(h("h1", null, "Roles"), h("p", { class: "row" }, h("a", { href: "/skills" }, "All skills"), newRole), error, formBox, body);

  const load = async () => {
    try {
      const res = await api.get<{ roles: Role[] }>("/api/roles");
      const list = Array.isArray(res?.roles) ? res.roles : [];
      body.replaceChildren(
        list.length
          ? h("div", { class: "cards" }, ...list.map(card))
          : h("p", { class: "muted" }, "No roles yet."),
      );
    } catch (e) {
      failure(error, e);
    }
  };

  const card = (r: Role) =>
    h(
      "article",
      { class: "card role" },
      h("h3", null, r.name, " ", h("button", { type: "button", class: "edit-role", onclick: () => open(r) }, "Edit role")),
      h("p", null, r.description),
      h(
        "dl",
        null,
        h("dt", null, "Skills"),
        h("dd", null, ...r.skills.flatMap((s, i) => [i ? ", " : "", h("a", { href: skillHref(s) }, s)])),
        h("dt", null, "Priority"),
        h("dd", null, String(r.priority)),
        h("dt", null, "Capability"),
        h("dd", null, `${r.capability} (${MODELS[r.capability] ?? "?"})`),
        h("dt", null, "When done"),
        h("dd", null, r.whenDone ?? "stop"),
        h("dt", null, "Brief"),
        h("dd", null, r.brief || h("span", { class: "muted" }, "none")),
      ),
    );

  /** The form for a new role, or for `r` when it is being edited. */
  const open = async (r: Role | undefined) => {
    let full = r;
    if (r && r.instructions === undefined) {
      try {
        full = (await api.get<{ role: Role }>(`/api/roles/${encodeURIComponent(r.name)}`)).role;
      } catch (e) {
        failure(error, e);
        return;
      }
    }
    const field = (label: string, el: HTMLElement) => h("label", { class: "field" }, h("span", null, label), el);
    const name = h("input", { type: "text", name: "name", value: full?.name ?? "", disabled: !!full, placeholder: "lowercase-with-hyphens" });
    const summary = h("input", { type: "text", name: "summary", value: full?.description ?? "", placeholder: "What the role is for, in a line" });
    const instructions = h("textarea", { name: "body", rows: 10, value: full?.instructions ?? "", placeholder: "What the agent is told first" });
    const skills = h("input", { type: "text", name: "skills", value: (full?.skills ?? []).filter((s) => s !== `roles/${full?.name}`).join(", "), placeholder: "other skills, comma separated" });
    const priority = h("input", { type: "number", name: "priority", min: 0, max: 100, value: String(full?.priority ?? 50) });
    const capability = h("select", { name: "capability" }, ...([1, 2, 3] as const).map((n) => h("option", { value: String(n), selected: (full?.capability ?? 2) === n }, `${n} ${MODELS[n]}`)));
    const whenDone = h("select", { name: "whenDone" }, ...(["stop", "keep"] as const).map((v) => h("option", { value: v, selected: (full?.whenDone ?? "stop") === v }, v)));
    const brief = h("textarea", { name: "brief", rows: 3, value: full?.brief ?? "", placeholder: "First message for an agent of this role" });
    const formError = h("p", { class: "error", hidden: true });
    const form = h(
      "form",
      {
        class: "form",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const payload = {
            summary: summary.value,
            body: instructions.value,
            skills: skills.value.split(",").map((s) => s.trim()).filter(Boolean),
            priority: Number(priority.value),
            capability: Number(capability.value),
            brief: brief.value.trim() === "" ? null : brief.value,
            whenDone: whenDone.value,
          };
          try {
            if (full) await api.send("PATCH", `/api/roles/${encodeURIComponent(full.name)}`, payload);
            else await api.send("POST", "/api/roles", { name: name.value, ...payload });
            formBox.replaceChildren();
            await load();
          } catch (err) {
            failure(formError, err);
          }
        },
      },
      h("h2", null, full ? `Edit role ${full.name}` : "New role"),
      field("Name", name),
      field("Summary", summary),
      field("Instructions", instructions),
      field("Other skills", skills),
      field("Priority", priority),
      field("Capability", capability),
      field("When done", whenDone),
      field("Brief", brief),
      formError,
      h("p", { class: "row" }, h("button", { type: "submit" }, full ? "Save role" : "Create role"), h("button", { type: "button", onclick: () => formBox.replaceChildren() }, "Cancel")),
    );
    formBox.replaceChildren(form);
    form.scrollIntoView?.();
  };

  await load();
}

export const pages: Page[] = [{ path: "/skills/roles", render: roles }];
