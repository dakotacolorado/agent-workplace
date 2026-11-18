import type { Api, Page } from "../../ui/page.ts";
import { renderMarkdown } from "../../agents/ui/markdown.ts";
import { changed, diffLines, type DiffLine } from "./diff.ts";
import { failure, h, skillApi, skillHref, when } from "./dom.ts";

interface Summary {
  name: string;
  description: string;
  version: number;
  kind: "hard" | "soft";
  protected: boolean;
  waiting: number;
  pending: boolean;
}
interface File {
  path: string;
  content: string;
}
interface Review {
  by: string;
  approved: boolean;
  reason: string;
  at: string;
}
interface Judgment {
  id: string;
  by: "judge" | "person" | "starter";
  actor: string | null;
  state: string;
  changed: boolean | null;
  reasoning: string;
  error: string | null;
  version: number | null;
  review: Review | null;
  startedAt: string;
  reports?: Report[];
}
interface Report {
  id: string;
  version: number;
  author: string;
  at: string;
  text: string;
  quote: string | null;
  evidence: string | null;
  whatChanged: string | null;
  judgment: string | null;
  sort: string | null;
  sortWhy: string | null;
}
interface Version {
  version: number;
  note: string;
  at: string;
  judgment?: Judgment;
}
interface SkillDoc {
  name: string;
  version: number;
  kind: "hard" | "soft";
  protected: boolean;
  files: File[];
  pending: { judgment: string; version: number; note: string; files: File[] } | null;
}

const SKILL_FILE = "SKILL.md";
const mdOf = (files: File[] | undefined) => files?.find((f) => f.path === SKILL_FILE)?.content ?? "";

/** The skills page: every skill, its kind, version and waiting reports, with search. */
async function list(into: HTMLElement, _p: Record<string, string>, api: Api) {
  const query = h("input", { type: "search", placeholder: "Search skills", "aria-label": "Search skills" });
  const body = h("div", null);
  into.replaceChildren(h("h1", null, "Skills"), h("p", { class: "row" }, query, h("a", { href: "/skills/roles" }, "Roles")), body);
  const show = async () => {
    const q = query.value.trim();
    try {
      const raw = await api.get<Summary[] | { skills: Summary[] }>(q ? `/api/skills/search?q=${encodeURIComponent(q)}&limit=50` : "/api/skills");
      const skills = Array.isArray(raw) ? raw : (raw.skills ?? []);
      body.replaceChildren(skills.length ? table(skills) : h("p", { class: "muted" }, q ? "No skill matches." : "No skills yet."));
    } catch (e) {
      const err = h("p", { class: "error" });
      failure(err, e);
      body.replaceChildren(err);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  query.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void show(), 200);
  });
  await show();
}

function table(skills: Summary[]): HTMLElement {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  return h(
    "table",
    { class: "list" },
    h("thead", null, h("tr", null, ...["Skill", "Kind", "Version", "Waiting"].map((t) => h("th", null, t)))),
    h(
      "tbody",
      null,
      ...sorted.map((s) => {
        const [ns, ...rest] = s.name.includes("/") ? s.name.split("/") : ["", s.name];
        return h(
          "tr",
          null,
          h("td", { class: "wide" }, ns && h("span", { class: "muted" }, `${ns}/`), h("a", { href: skillHref(s.name) }, rest.join("/")), h("div", { class: "muted small" }, s.description)),
          h("td", null, h("span", { class: `tag ${s.kind}` }, s.kind), s.pending && h("span", { class: "tag held" }, "revision held")),
          h("td", null, `v${s.version}`),
          h("td", null, s.waiting ? h("span", { class: "tag waiting" }, `${s.waiting} waiting`) : h("span", { class: "muted" }, "0")),
        );
      }),
    ),
  );
}

function renderDiff(d: DiffLine[]): HTMLElement {
  if (!changed(d)) return h("p", { class: "muted" }, "No change to this file.");
  return h("pre", { class: "diff" }, ...d.map((l) => h("div", { class: l.kind }, `${l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}${l.text}`)));
}

/** A SKILL.md as headings, lists, code and paragraphs, built from text only. */
export function markdown(text: string): HTMLElement {
  const out = h("div", { class: "md" });
  renderMarkdown(document, out, text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""));
  return out;
}

const reportView = (r: Report) =>
  h(
    "li",
    { class: "report" },
    h("div", { class: "muted small" }, `${r.author} · ${when(r.at)} · on v${r.version}`, r.sort && ` · ${r.sort}${r.sortWhy ? `: ${r.sortWhy}` : ""}`),
    r.text && h("p", null, r.text),
    r.quote && h("blockquote", null, r.quote),
    r.evidence && h("details", null, h("summary", null, "Evidence"), h("pre", null, r.evidence)),
    r.whatChanged && h("p", null, h("b", null, "Changed: "), r.whatChanged),
  );

const who = (j: Judgment) => (j.by === "judge" ? "The judge" : j.by === "starter" ? "Starter" : (j.actor ?? "The person"));

/** One skill: its text, held revision, versions with their judgments and diffs, waiting reports, and the person's actions. */
async function skill(into: HTMLElement, params: Record<string, string>, api: Api) {
  const name = params.ns ? `${params.ns}/${params.name}` : params.name!;
  const title = h("h1", null, `Skill ${name}`);
  const error = h("p", { class: "error", hidden: true });
  into.replaceChildren(title, h("p", { class: "muted" }, h("a", { href: "/skills" }, "All skills")), error);
  const reload = () => skill(into, params, api);
  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await reload();
    } catch (e) {
      failure(error, e);
    }
  };

  let doc: SkillDoc, hist: { versions: Version[]; judgments: Judgment[] }, feedback: Report[];
  try {
    [doc, hist, feedback] = await Promise.all([
      api.get<SkillDoc>(skillApi(name)),
      api.get<{ versions: Version[]; judgments: Judgment[] }>(skillApi(name, "/history")),
      api.get<Report[]>(skillApi(name, "/feedback")),
    ]);
    if (!doc || !Array.isArray(doc.files) || !hist || !Array.isArray(hist.versions)) throw new Error("unexpected answer");
  } catch (e) {
    failure(error, e);
    return;
  }
  const waiting = (Array.isArray(feedback) ? feedback : []).filter((r) => r.judgment === null);

  // Each version's files, for the diff against the one before.
  const files = new Map<number, File[]>([[doc.version, doc.files]]);
  await Promise.all(
    hist.versions
      .filter((v) => !files.has(v.version))
      .map(async (v) => {
        try {
          files.set(v.version, (await api.get<SkillDoc>(skillApi(name, `?version=${v.version}`))).files);
        } catch {
          /* a version with no readable files shows no diff */
        }
      }),
  );

  const reason = h("input", { type: "text", placeholder: "Reason (optional)", "aria-label": "Reason" });
  const header = h(
    "p",
    { class: "row" },
    h("span", { class: `tag ${doc.kind}` }, doc.kind),
    h("span", null, `version ${doc.version}`),
    doc.protected && h("span", { class: "tag held" }, "revisions need approval"),
  );

  // Actions
  const kind = h("select", { "aria-label": "Kind" }, h("option", { value: "hard", selected: doc.kind === "hard" }, "hard"), h("option", { value: "soft", selected: doc.kind === "soft" }, "soft"));
  const prot = h("input", { type: "checkbox", checked: doc.protected, id: "protected" });
  const actions = h(
    "section",
    { class: "actions" },
    h("h2", null, "Actions"),
    h(
      "p",
      { class: "row" },
      h("button", { type: "button", id: "judge", onclick: act(() => api.send("POST", skillApi(name, "/judge"))) }, "Ask the judge to consider it"),
      h("label", null, "Kind ", kind),
      h("button", { type: "button", id: "setkind", onclick: act(() => api.send("PATCH", skillApi(name), { kind: kind.value, protected: prot.checked })) }, "Save settings"),
      h("label", null, prot, " Hold revisions for approval"),
    ),
  );

  // Held revision
  const held = doc.pending
    ? h(
        "section",
        { class: "held" },
        h("h2", null, "A revision waits for you"),
        h("p", { class: "muted" }, doc.pending.note),
        renderDiff(diffLines(mdOf(doc.files), mdOf(doc.pending.files))),
        h(
          "p",
          { class: "row" },
          reason,
          h("button", { type: "button", id: "approve", onclick: act(() => api.send("POST", skillApi(name, "/approve"), { reason: reason.value })) }, "Approve"),
          h("button", { type: "button", id: "decline", onclick: act(() => api.send("POST", skillApi(name, "/decline"), { reason: reason.value })) }, "Decline"),
        ),
      )
    : null;

  // Edit
  const paths = doc.files.map((f) => f.path);
  const path = h("input", { type: "text", value: SKILL_FILE, list: "skill-files", "aria-label": "File path" });
  const text = h("textarea", { rows: 14, "aria-label": "File text", value: mdOf(doc.files) });
  const pick = () => void (text.value = doc.files.find((f) => f.path === path.value)?.content ?? "");
  path.addEventListener("change", pick);
  const edit = h(
    "section",
    { class: "edit" },
    h("h2", null, "Edit"),
    h("datalist", { id: "skill-files" }, ...paths.map((p) => h("option", { value: p }))),
    h("p", { class: "row" }, h("label", null, "File ", path)),
    text,
    h("p", { class: "row" }, h("input", { type: "text", id: "edit-reason", placeholder: "Reason (optional)", "aria-label": "Edit reason" }), h("button", { type: "button", id: "save", onclick: act(() => api.send("PUT", skillApi(name), { write: [{ path: path.value, content: text.value }], reason: (into.querySelector("#edit-reason") as HTMLInputElement).value })) }, "Save as new version")),
  );

  // Waiting reports
  const waitingView = h("section", null, h("h2", null, `Waiting reports (${waiting.length})`), waiting.length ? h("ul", { class: "reports" }, ...waiting.map(reportView)) : h("p", { class: "muted" }, "Nothing waits for the judge."));

  // Versions
  const byJudgment = new Map(hist.judgments.map((j) => [j.id, j]));
  const versions = h(
    "section",
    { id: "versions" },
    h("h2", null, "Versions"),
    ...hist.versions.map((v) => {
      const j = v.judgment ?? undefined;
      const full = j && byJudgment.get(j.id);
      const prev = files.get(v.version - 1);
      const mine = files.get(v.version);
      const paths = [...new Set([...(mine ?? []).map((f) => f.path), ...(prev ?? []).map((f) => f.path)])].sort();
      const diffs = mine && v.version > 1 && prev ? paths.map((p) => ({ p, d: diffLines(prev.find((f) => f.path === p)?.content ?? "", mine.find((f) => f.path === p)?.content ?? "") })).filter((x) => changed(x.d)) : [];
      return h(
        "article",
        { class: "version" },
        h(
          "h3",
          null,
          `v${v.version}`,
          " ",
          h("span", { class: "muted small" }, `${when(v.at)} · ${j ? who(j) : "unknown"}`),
          v.version !== doc.version && h("button", { type: "button", class: "revert", onclick: act(() => api.send("POST", skillApi(name, "/revert"), { version: v.version, reason: reason.value })) }, "Revert to this"),
        ),
        v.note && h("p", null, v.note),
        j?.reasoning && h("p", { class: "reasoning" }, h("b", null, "Judgment: "), j.reasoning),
        j?.review && h("p", { class: "muted small" }, `${j.review.approved ? "Approved" : "Declined"} by ${j.review.by}${j.review.reason ? `: ${j.review.reason}` : ""}`),
        full?.reports?.length ? h("details", null, h("summary", null, `${full.reports.length} report${full.reports.length === 1 ? "" : "s"} behind it`), h("ul", { class: "reports" }, ...full.reports.map(reportView))) : null,
        v.version === 1 ? h("p", { class: "muted" }, "First version.") : diffs.length ? h("div", null, ...diffs.map((x) => h("div", null, h("div", { class: "muted small" }, x.p), renderDiff(x.d)))) : h("p", { class: "muted" }, "No change to the files."),
      );
    }),
  );
  const declined = hist.judgments.filter((j) => j.version === null && j.reasoning);
  const noChange = declined.length
    ? h("section", null, h("h2", null, "Judgments that changed nothing"), ...declined.map((j) => h("article", { class: "version" }, h("div", { class: "muted small" }, `${when(j.startedAt)} · ${who(j)} · ${j.state}`), h("p", { class: "reasoning" }, j.reasoning))))
    : null;

  into.replaceChildren(title, h("p", { class: "muted" }, h("a", { href: "/skills" }, "All skills")), error, header, ...(held ? [held] : []), actions, h("h2", null, "Text"), markdown(mdOf(doc.files)), waitingView, versions, ...(noChange ? [noChange] : []), edit);
}

export const pages: Page[] = [
  { path: "/skills", nav: "Skills", render: list },
  { path: "/skills/:name", render: skill },
  { path: "/skills/:ns/:name", render: skill },
];
