import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.ts";
import type { Module } from "../module.ts";
import { createRoles } from "../roles/index.ts";
import { modules } from "../modules.ts";
import { createSkills } from "./index.ts";
import { ClaudeJudge, decisionJsonSchema, render, type Case, type Decision, type Judge } from "./judge.ts";

/** A judge that decides as the test says, and keeps every case it was given. */
class FakeJudge implements Judge {
  cases: Case[] = [];
  decideWith: (c: Case) => Decision;
  constructor(decideWith: (c: Case) => Decision) {
    this.decideWith = decideWith;
  }
  async decide(c: Case): Promise<Decision> {
    this.cases.push(c);
    return this.decideWith(c);
  }
}

const decision = (d: Partial<Decision>): Decision => ({ reasoning: "", changed: false, note: "", edits: [], write: [], remove: [], sorted: [], revert_to: 0, judge_feedback: "", ...d });
const acceptAll = (c: Case, edit: { old: string; new: string }): Decision =>
  decision({
    reasoning: "The evidence shows the line is wrong.",
    changed: true,
    note: "Fixed from the report",
    edits: [{ path: "SKILL.md", ...edit }],
    sorted: c.feedback.map((f) => ({ report: f.id.slice(0, 8), kind: "accepted", why: "shown wrong" })),
  });
const declineAll = (c: Case): Decision =>
  decision({ reasoning: "A preference with nothing behind it.", sorted: c.feedback.map((f) => ({ report: f.id.slice(0, 8), kind: "declined", why: "a preference" })) });

let dirs: string[] = [];
let apps: App[] = [];
// Without the default roles, so the library holds only what these tests make.
const withSkills = (skills: Module) => modules.map((m) => (m.name === "skills" ? skills : m.name === "roles" ? createRoles({ defaults: [] }) : m));
const start = (judge: Judge | null, dir = mkdtempSync(join(tmpdir(), "awp-skills-")), extra: Module[] = []) => {
  dirs.push(dir);
  const app = createApp({ dir, modules: [...withSkills(createSkills({ judge, log: () => {} })), ...extra] });
  apps.push(app);
  return app;
};
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of [...new Set(dirs)]) rmSync(d, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

const enc = encodeURIComponent;
const call = async (app: App, method: string, path: string, body?: unknown, token = app.adminToken) => {
  const res = await app.fetch(
    new Request(`http://localhost/api/skills${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
};
/** Waits for the judge to finish whatever it started. */
const settle = async (app: App) => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
  void app;
};
const mcp = async (app: App, token: string) => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  );
  return client;
};
const toolText = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const LINE = "Run npm run lint before you push.";

/** Makes team/deploys at v1 by the person's hand. */
const makeDeploys = async (app: App, kind?: "soft") => {
  expect((await call(app, "PUT", `/${enc("team/deploys")}`, { write: [{ path: "SKILL.md", content: skillMd("deploys", "Use when deploying.", LINE) }] })).status).toBe(200);
  if (kind) expect((await call(app, "PATCH", `/${enc("team/deploys")}`, { kind })).status).toBe(200);
};

describe("starters", () => {
  it("seeds the two judge skills and skill-writing on a fresh app, and no honer", async () => {
    const app = start(null);
    const names = (await call(app, "GET", "")).body.map((s: { name: string }) => s.name);
    expect(names).toEqual(["workplace/hard-skill-judge", "workplace/skill-writing", "workplace/soft-skill-judge"]);
    expect(names.some((n: string) => n.includes("honer"))).toBe(false);
    const history = (await call(app, "GET", `/${enc("workplace/skill-writing")}/history`)).body;
    expect(history.versions).toHaveLength(1);
    expect(history.versions[0].judgment).toMatchObject({ by: "starter", changed: true });
  });

  it("seeds once: a restart adds nothing, and a starter the person deleted stays deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awp-skills-"));
    const first = start(null, dir);
    expect((await call(first, "DELETE", `/${enc("workplace/skill-writing")}`)).status).toBe(200);
    await first.close();
    apps = [];
    const second = start(null, dir);
    const names = (await call(second, "GET", "")).body.map((s: { name: string; version: number }) => `${s.name}@${s.version}`);
    expect(names).toEqual(["workplace/hard-skill-judge@1", "workplace/soft-skill-judge@1"]);
  });

  it("lets another module seed its own skills, once", async () => {
    const app = start(null);
    const starter = { name: "agent-roles/implementer", files: [{ path: "SKILL.md", content: skillMd("implementer", "The implementer role.", "Do one task.") }, { path: "role.json", content: "{}" }] };
    expect(await app.ctx.services.skills.seed([starter])).toEqual(["agent-roles/implementer"]);
    expect(await app.ctx.services.skills.seed([starter])).toEqual([]);
    expect((await app.ctx.services.skills.get("agent-roles/implementer"))?.files.map((f) => f.path)).toEqual(["role.json", "SKILL.md"]);
  });
});

describe("versions", () => {
  it("keeps every version with the judgment that made it, reads any version, and reverts", async () => {
    const app = start(null);
    await makeDeploys(app);
    const v2 = skillMd("deploys", "Use when deploying.", "Run npm test before you push.");
    expect((await call(app, "PUT", `/${enc("team/deploys")}`, { write: [{ path: "SKILL.md", content: v2 }], reason: "tests, not lint" })).body).toMatchObject({ by: "person", version: 2 });
    expect((await call(app, "GET", `/${enc("team/deploys")}`)).body).toMatchObject({ version: 2, files: [{ content: v2 }] });
    expect((await call(app, "GET", `/${enc("team/deploys")}?version=1`)).body.files[0].content).toContain(LINE);

    const reverted = (await call(app, "POST", `/${enc("team/deploys")}/revert`, { version: 1, reason: "lint was right" })).body;
    expect(reverted).toMatchObject({ version: 3, reasoning: "lint was right" });
    expect((await app.ctx.services.skills.get("team/deploys"))?.files[0]?.content).toContain(LINE);
    const history = (await call(app, "GET", `/${enc("team/deploys")}/history`)).body;
    expect(history.versions.map((v: { version: number; note: string }) => [v.version, v.note])).toEqual([
      [3, "Revert to version 1"],
      [2, "Edited by hand: SKILL.md"],
      [1, "Edited by hand: SKILL.md"],
    ]);
    expect(history.versions[1].judgment.reasoning).toBe("tests, not lint");
  });

  it("lists and searches by name and description", async () => {
    const app = start(null);
    await makeDeploys(app);
    expect((await call(app, "GET", "/search?q=deploying")).body.map((s: { name: string }) => s.name)).toEqual(["team/deploys"]);
    expect((await call(app, "GET", "/search?q=judge")).body.map((s: { name: string }) => s.name)).toEqual(["workplace/hard-skill-judge", "workplace/soft-skill-judge"]);
    expect((await app.ctx.services.skills.list()).map((s) => s.name)).toContain("team/deploys");
  });

  it("refuses a skill whose SKILL.md does not name it, and changes by an agent", async () => {
    const app = start(null);
    expect((await call(app, "PUT", `/${enc("team/x")}`, { write: [{ path: "SKILL.md", content: skillMd("y", "d", "b") }] })).status).toBe(400);
    const agent = app.ctx.tokens.issue("a1");
    expect((await call(app, "PUT", `/${enc("team/x")}`, { write: [{ path: "SKILL.md", content: skillMd("x", "d", "b") }] }, agent)).status).toBe(403);
  });
});

describe("feedback and the judge", () => {
  it("queues a report sent over /mcp; the judge accepts it into a new version, with its reasoning in the history", async () => {
    const judge = new FakeJudge((c) => acceptAll(c, { old: LINE, new: "Run npm run check before you push." }));
    const app = start(judge);
    await makeDeploys(app);
    const client = await mcp(app, app.ctx.tokens.issue("agent-7"));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_skills", "get_skill", "search_skills", "submit_feedback"]));
    expect(client.getInstructions()).toContain("submit_feedback");
    const sent = await client.callTool({ name: "submit_feedback", arguments: { skill: "team/deploys", quote: LINE, evidence: "$ npm run lint\nnpm error Missing script: lint", what_changed: "ran npm run check" } });
    expect(toolText(sent)).toContain("Recorded");
    await client.close();
    await settle(app);

    expect(judge.cases).toHaveLength(1);
    expect(judge.cases[0]!.guidance).toContain("Revising a skill from feedback");
    expect((await app.ctx.services.skills.get("team/deploys"))?.version).toBe(2);
    const history = (await call(app, "GET", `/${enc("team/deploys")}/history`)).body;
    const made = history.judgments.find((j: { by: string }) => j.by === "judge");
    expect(made).toMatchObject({ changed: true, version: 2, reasoning: "The evidence shows the line is wrong." });
    expect(made.reports[0]).toMatchObject({ author: "agent agent-7", sort: "accepted", sortWhy: "shown wrong", quote: LINE });
  });

  it("declines a report without writing a version", async () => {
    const judge = new FakeJudge(declineAll);
    const app = start(judge);
    await makeDeploys(app);
    await app.ctx.services.skills.submitFeedback({ skill: "team/deploys", quote: LINE, evidence: "I prefer yarn", whatChanged: "used yarn" }, { kind: "person" });
    await settle(app);
    expect((await app.ctx.services.skills.get("team/deploys"))?.version).toBe(1);
    const feedback = (await call(app, "GET", `/${enc("team/deploys")}/feedback`)).body;
    expect(feedback[0]).toMatchObject({ author: "person", sort: "declined", sortWhy: "a preference" });
    const j = (await call(app, "GET", `/${enc("team/deploys")}/history`)).body.judgments[0];
    expect(j).toMatchObject({ by: "judge", changed: false, reasoning: "A preference with nothing behind it." });
  });

  it("refuses a report on a hard skill without a quote it holds, evidence and what changed, saying how to fix it", async () => {
    const judge = new FakeJudge(declineAll);
    const app = start(judge);
    await makeDeploys(app);
    const s = app.ctx.services.skills;
    await expect(s.submitFeedback({ skill: "team/deploys", evidence: "x", whatChanged: "y" }, { kind: "person" })).rejects.toThrow(/needs quote/);
    await expect(s.submitFeedback({ skill: "team/deploys", quote: "Run yarn before you push.", evidence: "x", whatChanged: "y" }, { kind: "person" })).rejects.toThrow(/not in team\/deploys/);
    await expect(s.submitFeedback({ skill: "team/deploys", quote: LINE, whatChanged: "y" }, { kind: "person" })).rejects.toThrow(/needs evidence/);
    await settle(app);
    expect(judge.cases).toHaveLength(0);
  });

  it("makes a new skill from a request under a name no skill has", async () => {
    const judge = new FakeJudge(() => decision({ reasoning: "Distinct and needed.", changed: true, note: "New skill", write: [{ path: "SKILL.md", content: skillMd("reviews", "Use when reviewing a PR.", "Read the diff."), executable: false }] }));
    const app = start(judge);
    await app.ctx.services.skills.submitFeedback({ skill: "team/reviews", text: "How we review PRs." }, { kind: "person" });
    await settle(app);
    expect(judge.cases[0]!.writingGuide).toContain("Writing a new skill");
    expect((await app.ctx.services.skills.get("team/reviews"))?.version).toBe(1);
  });

  it("refuses a decision that changes a skill while accepting no report, and keeps the skill as it was", async () => {
    const judge = new FakeJudge((c) => ({ ...acceptAll(c, { old: LINE, new: "Whatever." }), sorted: c.feedback.map((f) => ({ report: f.id.slice(0, 8), kind: "declined", why: "no" })) }));
    const app = start(judge);
    await makeDeploys(app);
    await app.ctx.services.skills.submitFeedback({ skill: "team/deploys", quote: LINE, evidence: "e", whatChanged: "w" }, { kind: "person" });
    await settle(app);
    expect(judge.cases).toHaveLength(3);
    expect(judge.cases[1]!.failure).toMatch(/accepted no report/);
    expect((await app.ctx.services.skills.get("team/deploys"))?.version).toBe(1);
  });

  it("holds a protected skill's revision for the person, who approves it", async () => {
    const judge = new FakeJudge((c) => acceptAll(c, { old: LINE, new: "Run npm run check before you push." }));
    const app = start(judge);
    await makeDeploys(app);
    await call(app, "PATCH", `/${enc("team/deploys")}`, { protected: true });
    await app.ctx.services.skills.submitFeedback({ skill: "team/deploys", quote: LINE, evidence: "e", whatChanged: "w" }, { kind: "person" });
    await settle(app);
    const held = (await call(app, "GET", `/${enc("team/deploys")}`)).body;
    expect(held).toMatchObject({ version: 1, pending: { version: 1, note: "Fixed from the report" } });
    expect((await call(app, "POST", `/${enc("team/deploys")}/approve`, { reason: "good" })).body).toMatchObject({ version: 2, review: { approved: true, reason: "good" } });
    expect((await app.ctx.services.skills.get("team/deploys"))?.files[0]?.content).toContain("npm run check");
  });
});

describe("soft skills", () => {
  /** Holds a lone observation; accepts once two separate sessions say the same, as honed's soft judging does. */
  const patternJudge = () =>
    new FakeJudge((c) => {
      const fresh = c.feedback.filter((f) => f.sort === null || f.sort === "held");
      const authors = new Set(fresh.map((f) => f.author));
      if (authors.size < 2) return decision({ reasoning: "One session: not yet a pattern.", sorted: c.feedback.filter((f) => f.sort === null).map((f) => ({ report: f.id.slice(0, 8), kind: "held", why: "a hint" })) });
      return decision({
        reasoning: "Two sessions agree.",
        changed: true,
        note: "From a pattern",
        edits: [{ path: "SKILL.md", old: LINE, new: `${LINE}\nThe person keeps short commit messages.` }],
        sorted: fresh.map((f) => ({ report: f.id.slice(0, 8), kind: "accepted", why: "two sessions agree" })),
      });
    });

  it("holds one observation and changes only once reports from separate sessions agree", async () => {
    const judge = patternJudge();
    const app = start(judge);
    await makeDeploys(app, "soft");
    const s = app.ctx.services.skills;
    await s.submitFeedback({ skill: "team/deploys", text: "The person cut my long commit message to one line." }, { kind: "agent", agentId: "a1" });
    await settle(app);
    expect((await s.get("team/deploys"))?.version).toBe(1);
    expect((await call(app, "GET", `/${enc("team/deploys")}/feedback`)).body[0]).toMatchObject({ sort: "held" });

    await s.submitFeedback({ skill: "team/deploys", text: "The person rewrote my commit message shorter." }, { kind: "agent", agentId: "a2" });
    await settle(app);
    expect(judge.cases).toHaveLength(2);
    expect(judge.cases[1]!.kind).toBe("soft");
    expect(judge.cases[1]!.feedback.map((f) => f.sort)).toEqual(["held", null]);
    expect(render(judge.cases[1]!)).toContain('sorted_before="held"');
    expect((await s.get("team/deploys"))?.version).toBe(2);
    expect((await call(app, "GET", `/${enc("team/deploys")}/feedback`)).body.map((f: { sort: string }) => f.sort)).toEqual(["accepted", "accepted"]);
  });

  it("refuses a soft change with no report accepted", async () => {
    const judge = new FakeJudge((c) =>
      decision({ changed: true, note: "x", edits: [{ path: "SKILL.md", old: LINE, new: "Other." }], sorted: c.feedback.filter((f) => f.sort === null).map((f) => ({ report: f.id.slice(0, 8), kind: "held", why: "hint" })) }),
    );
    const app = start(judge);
    await makeDeploys(app, "soft");
    await app.ctx.services.skills.submitFeedback({ skill: "team/deploys", text: "One hint." }, { kind: "person" });
    await settle(app);
    expect((await app.ctx.services.skills.get("team/deploys"))?.version).toBe(1);
  });

  it("refuses to hold a report on a hard skill", async () => {
    const judge = new FakeJudge((c) => decision({ sorted: c.feedback.map((f) => ({ report: f.id.slice(0, 8), kind: "held", why: "wait" })) }));
    const app = start(judge);
    await makeDeploys(app);
    await app.ctx.services.skills.submitFeedback({ skill: "team/deploys", quote: LINE, evidence: "e", whatChanged: "w" }, { kind: "person" });
    await settle(app);
    expect(judge.cases[1]!.failure).toMatch(/hard skill/);
  });
});

describe("the judge skills", () => {
  it("cannot be deleted, nor made soft", async () => {
    const app = start(null);
    for (const name of ["workplace/hard-skill-judge", "workplace/soft-skill-judge"]) {
      expect((await call(app, "DELETE", `/${enc(name)}`)).status).toBe(409);
      expect((await call(app, "PATCH", `/${enc(name)}`, { kind: "soft" })).status).toBe(409);
    }
    expect((await call(app, "GET", "")).body).toHaveLength(3);
  });

  it("change from feedback only when the person asks the judge to consider them", async () => {
    const judge = new FakeJudge((c) => acceptAll(c, { old: "No change is a fine outcome.", new: "No change is a fine outcome, often the best." }));
    const app = start(judge);
    const agent = app.ctx.tokens.issue("a1");
    const client = await mcp(app, agent);
    const sent = await client.callTool({ name: "submit_feedback", arguments: { skill: "workplace/hard-skill-judge", quote: "No change is a fine outcome.", evidence: "e", what_changed: "w" } });
    expect(toolText(sent)).toContain("only when the person asks");
    await client.close();
    await settle(app);
    expect(judge.cases).toHaveLength(0);
    expect((await app.ctx.services.skills.get("workplace/hard-skill-judge"))?.version).toBe(1);

    expect((await call(app, "POST", `/${enc("workplace/hard-skill-judge")}/judge`, {}, agent)).status).toBe(403);
    expect((await call(app, "POST", `/${enc("workplace/hard-skill-judge")}/judge`, {})).status).toBe(200);
    await settle(app);
    expect(judge.cases).toHaveLength(1);
    expect(judge.cases[0]!.asked).toBe(true);
    expect((await app.ctx.services.skills.get("workplace/hard-skill-judge"))?.version).toBe(2);
  });

  it("take the judge's notes on its own guidance as feedback that waits for the person", async () => {
    const judge = new FakeJudge((c) => ({ ...declineAll(c), judge_feedback: "The guidance says nothing about drafts that rename a skill." }));
    const app = start(judge);
    await makeDeploys(app);
    await app.ctx.services.skills.submitFeedback({ skill: "team/deploys", quote: LINE, evidence: "e", whatChanged: "w" }, { kind: "person" });
    await settle(app);
    const notes = (await call(app, "GET", `/${enc("workplace/hard-skill-judge")}/feedback`)).body;
    expect(notes[0]).toMatchObject({ author: "the judge (judging team/deploys)", judgment: null });
    expect(judge.cases).toHaveLength(1);
  });
});

describe("the Claude judge", () => {
  const c: Case = { skill: "team/deploys", version: 1, kind: "hard", maxChars: 20000, files: [], others: [], feedback: [], window: 20, precedent: [], asked: false, failure: null, guidance: "Decide well.", writingGuide: null };

  it("runs one Agent SDK session with no tools, settings or MCP servers, and reads its structured output", async () => {
    let seen: { prompt: string; options: Record<string, unknown> } | undefined;
    const out = decision({ reasoning: "ok" });
    const judge = new ClaudeJudge({
      query: (params) => {
        seen = params as never;
        return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "", structured_output: out } as never;
        })();
      },
    });
    expect(await judge.decide(c)).toEqual(out);
    expect(seen!.options).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, settingSources: [], persistSession: false, strictMcpConfig: true });
    expect(seen!.options.systemPrompt).toContain("Decide well.");
    expect(seen!.options.systemPrompt).toContain("workplace/hard-skill-judge");
    expect(seen!.prompt).toContain('<skill name="team/deploys"');
  });

  it("never reaches Claude in a test, even unfaked", async () => {
    await expect(new ClaudeJudge().decide(c)).rejects.toThrow(/tests never call Claude/);
  });

  it("gives a JSON schema without $schema, holding held only for soft skills", () => {
    const hard = JSON.stringify(decisionJsonSchema("hard"));
    expect(hard).not.toContain("$schema");
    expect(hard).not.toContain('"held"');
    expect(JSON.stringify(decisionJsonSchema("soft"))).toContain('"held"');
  });
});
