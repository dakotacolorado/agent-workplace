import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../../app.ts";
import { modules } from "../../modules.ts";
import { createRoles } from "../../roles/index.ts";
import { pages } from "../../ui/pages.ts";
import { shell, TOKEN_KEY } from "../../ui/shell.ts";
import { createSkills } from "../index.ts";
import type { Case, Decision, Judge } from "../judge.ts";
import { diffLines } from "./diff.ts";
import { markdown } from "./skills.ts";

// The app reads files by URL, which the happy-dom environment breaks: keep node and give the page its own window.
const win = new Window({ url: "http://localhost/" });
const document = win.document as unknown as Document;
const localStorage = win.localStorage;
Object.assign(globalThis, { document });

const LINE = "Run npm run lint before you push.";
const md = (body: string) => `---\nname: deploys\ndescription: Use when deploying.\n---\n\n${body}\n`;

class FakeJudge implements Judge {
  async decide(c: Case): Promise<Decision> {
    return {
      reasoning: "The evidence shows the script is missing.",
      changed: true,
      note: "Fixed from the report",
      edits: [{ path: "SKILL.md", old: LINE, new: "Run npm run check before you push." }],
      write: [],
      remove: [],
      sorted: c.feedback.map((f) => ({ report: f.id.slice(0, 8), kind: "accepted", why: "shown wrong" })),
      revert_to: 0,
      judge_feedback: "",
    } as Decision;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await sleep(10);
  expect(f()).toBe(true);
};

let dir = "";
let app: App;
const visit = async (path: string) => {
  win.history.replaceState(null, "", path);
  await shell(document, {
    pages,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(new URL(String(input), "http://localhost"), init))) as typeof fetch,
  });
};
const api = async (method: string, path: string, body?: unknown) =>
  (await app.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer ${app.adminToken}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }))).json() as Promise<any>;
const click = (sel: string) => (document.querySelector(sel) as HTMLElement).click();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "awp-skills-ui-"));
  app = createApp({ dir, modules: modules.map((m) => (m.name === "skills" ? createSkills({ judge: new FakeJudge(), log: () => {} }) : m.name === "roles" ? createRoles({ defaults: [] }) : m)) });
  localStorage.setItem(TOKEN_KEY, app.adminToken);
  await api("PUT", "/api/skills/team%2Fdeploys", { write: [{ path: "SKILL.md", content: md(LINE) }] });
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("diffLines", () => {
  it("marks added and deleted lines between the same ones", () => {
    expect(diffLines("a\nb\nc\n", "a\nx\nc\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });
});

describe("markdown", () => {
  it("keeps a wrapped list item in one li and renders bold and code", () => {
    const el = markdown("---\nname: x\n---\n\n- Read the code: clone the repos and find\n  what each task would change, **now** with `npm`.\n- Second\n");
    const lis = el.querySelectorAll("li");
    expect(lis.length).toBe(2);
    expect(lis[0]!.textContent).toContain("clone the repos and find");
    expect(lis[0]!.textContent).toContain("what each task would change");
    expect(lis[0]!.querySelector("strong")?.textContent).toBe("now");
    expect(lis[0]!.querySelector("code")?.textContent).toBe("npm");
    expect(el.textContent).not.toContain("**");
    expect(el.textContent).not.toContain("`");
    expect(el.querySelectorAll("p").length).toBe(0);
  });
  it("never takes text as HTML", () => {
    const el = markdown("<script>x</script> **b**");
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<script>");
  });
});

describe("the Skills page", () => {
  it("lists skills with kind, version and waiting reports, and searches them", async () => {
    await api("POST", "/api/skills/feedback", { skill: "team/deploys", quote: LINE, evidence: "npm error Missing script: lint", whatChanged: "ran check" });
    await visit("/skills");
    await until(() => document.querySelectorAll("table.list tbody tr").length >= 2);
    const row = [...document.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes("deploys"))!;
    expect(row.textContent).toContain("hard");
    expect(row.textContent).toContain("v2");
    const q = document.querySelector("input[type=search]") as HTMLInputElement;
    q.value = "deploying";
    q.dispatchEvent(new win.Event("input") as unknown as Event);
    await until(() => document.querySelectorAll("tbody tr").length === 1);
    expect(document.querySelector("tbody tr")?.textContent).toContain("deploys");
  });

  it("shows a version with the judge's reasoning and a diff, and reverts", async () => {
    await api("POST", "/api/skills/feedback", { skill: "team/deploys", quote: LINE, evidence: "npm error Missing script: lint", whatChanged: "ran check" });
    await until(() => !!document.body && true);
    await sleep(100);
    await visit("/skills/team/deploys");
    await until(() => !!document.querySelector("#versions article"));
    const v = document.querySelector("#versions article")!;
    expect(v.textContent).toContain("v2");
    expect(v.textContent).toContain("The evidence shows the script is missing.");
    expect(v.querySelector(".diff .del")?.textContent).toContain("npm run lint");
    expect(v.querySelector(".diff .add")?.textContent).toContain("npm run check");
    click(".revert");
    await until(() => document.querySelector("#versions article h3")?.textContent?.startsWith("v3") ?? false);
    expect(document.querySelector("#versions")?.textContent).toContain("Revert");
  });

  it("edits a file from the page as a new version", async () => {
    await visit("/skills/team/deploys");
    await until(() => !!document.querySelector("textarea"));
    (document.querySelector("textarea") as HTMLTextAreaElement).value = md("Run it twice.");
    click("#save");
    await until(() => document.querySelector("#versions article h3")?.textContent?.startsWith("v2") ?? false);
    expect(document.querySelector("#versions .diff .add")?.textContent).toContain("Run it twice.");
  });

  it("holds a revision of a protected skill, then approves it, and declines another", async () => {
    await api("PATCH", "/api/skills/team%2Fdeploys", { protected: true });
    const report = { skill: "team/deploys", quote: LINE, evidence: "npm error Missing script: lint", whatChanged: "ran check" };
    await api("POST", "/api/skills/feedback", report);
    await sleep(150);
    await visit("/skills/team/deploys");
    await until(() => !!document.querySelector("#approve"));
    expect(document.querySelector(".held .diff .add")?.textContent).toContain("npm run check");
    click("#approve");
    await until(() => !document.querySelector("#approve") && !!document.querySelector("#versions article h3")?.textContent?.startsWith("v2"));

  });

  it("declines a held revision and keeps the skill as it is", async () => {
    await api("PATCH", "/api/skills/team%2Fdeploys", { protected: true });
    await api("POST", "/api/skills/feedback", { skill: "team/deploys", quote: LINE, evidence: "npm error Missing script: lint", whatChanged: "ran check" });
    await sleep(150);
    await visit("/skills/team/deploys");
    await until(() => !!document.querySelector("#decline"));
    click("#decline");
    await until(() => !document.querySelector("#decline"));
    expect(document.querySelector("#versions article h3")?.textContent).toMatch(/^v1/);
  });
});

describe("the Roles page", () => {
  it("creates a role from the form and lists it, then edits it", async () => {
    await visit("/skills/roles");
    await until(() => !!document.querySelector("#new-role"));
    click("#new-role");
    const set = (name: string, value: string) => {
      const el = document.querySelector(`[name=${name}]`) as HTMLInputElement;
      el.value = value;
    };
    set("name", "reviewer");
    set("summary", "Reviews changes");
    set("body", "Read the diff.");
    set("priority", "70");
    set("brief", "Start with the newest PR");
    (document.querySelector("form") as HTMLFormElement).requestSubmit();
    await until(() => !!document.querySelector(".role"));
    const card = document.querySelector(".role")!;
    expect(card.textContent).toContain("reviewer");
    expect(card.textContent).toContain("Reviews changes");
    expect(card.textContent).toContain("70");
    expect(card.textContent).toContain("Start with the newest PR");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/skills/roles/reviewer");

    click(".edit-role");
    await until(() => !!document.querySelector("form [name=body]"));
    expect((document.querySelector("[name=body]") as HTMLTextAreaElement).value).toBe("Read the diff.");
    (document.querySelector("[name=priority]") as HTMLInputElement).value = "90";
    (document.querySelector("form") as HTMLFormElement).requestSubmit();
    await until(() => document.querySelector(".role")?.textContent?.includes("90") ?? false);
  });
});
