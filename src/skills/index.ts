import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context as HonoContext } from "hono";
import type { Caller, Skill, Skills } from "../contracts.ts";
import { tool, type Context, type Env, type Module } from "../module.ts";
import { Refusal, SKILL_FILE, WRITING_SKILL } from "./domain.ts";
import { ClaudeJudge, type Judge } from "./judge.ts";
import { Library } from "./library.ts";
import { STARTERS } from "./starters.ts";
import { MIGRATIONS, Store } from "./store.ts";

export const INSTRUCTIONS = `Skills are how this workplace does its work, and they improve from your reports.
- Before a task, search_skills for what it is about (or list_skills), and get_skill any whose description fits. Follow what you read.
- If you edited something a skill mentions, or a skill gave you wrong information, report it before you finish with submit_feedback: quote the skill's exact text, give the evidence (the file as it is now, or the command and what it printed) and what_changed (what you did instead). Otherwise send nothing. Never include secrets or personal details.
- To add a skill, read ${WRITING_SKILL} first, then submit_feedback under the new name with what it is for and a draft of its ${SKILL_FILE}.`;

export interface SkillsOptions {
  /** Who decides feedback: Claude through the Agent SDK unless given; null for none (skills change only by hand). */
  judge?: Judge | null;
  /** The cap on a skill's text, all its files together. */
  maxChars?: number;
  log?: (line: string) => void;
}

/** The judge the app runs: Claude on this machine's login, unless `AGENT_WORKPLACE_JUDGE=off`. */
export function defaultJudge(env: NodeJS.ProcessEnv = process.env): Judge | null {
  if (env.AGENT_WORKPLACE_JUDGE === "off") return null;
  return new ClaudeJudge({ model: env.AGENT_WORKPLACE_JUDGE_MODEL || undefined });
}

const FileSchema = z.object({ path: z.string(), content: z.string(), executable: z.boolean().optional() }).openapi("SkillFile");
const Name = z.object({ name: z.string().openapi({ description: "The skill's name, its slash URL-encoded: workplace%2Fskill-writing." }) });
const json = (schema: z.ZodType, description: string) => ({ description, content: { "application/json": { schema } } });
const ErrorSchema = z.object({ error: z.string() });
const errors = { 400: json(ErrorSchema, "Refused, with how to fix it."), 403: json(ErrorSchema, "Only the person may do this."), 404: json(ErrorSchema, "No such skill."), 409: json(ErrorSchema, "Not allowed in the skill's state.") };
const body = (schema: z.ZodType) => ({ body: { content: { "application/json": { schema } }, required: true } });
const Any = z.any();

/** The skills agents work by, versioned, revised by a Claude judge from their feedback. */
export function createSkills(opts: SkillsOptions = {}): Module {
  return {
    name: "skills",
    migrations: MIGRATIONS,
    create(ctx: Context) {
      const store = new Store(ctx.db);
      const judge = opts.judge === undefined ? defaultJudge() : opts.judge;
      const library = new Library(store, judge, { maxChars: opts.maxChars, log: opts.log ?? ((line) => console.log(`skills: ${line}`)) });
      library.seedNow(STARTERS);
      library.start();

      /** Who a caller is, as feedback and history name them. */
      const who = async (caller: Caller): Promise<string> => {
        if (caller.kind === "person") return "person";
        try {
          return (await ctx.services.agents?.get(caller.agentId))?.name ?? `agent ${caller.agentId}`;
        } catch {
          return `agent ${caller.agentId}`;
        }
      };
      const person = (caller: Caller) => {
        if (caller.kind !== "person") throw new Refusal("only the person changes a skill directly; an agent sends submit_feedback", 403);
      };
      const must = (s: Skill | undefined, name: string): Skill => {
        if (!s) throw new Refusal(`no skill is named ${name}`, 404);
        return s;
      };

      const service: Skills = {
        get: async (name, version) => library.get(name, version),
        list: async () => library.list().map((s) => library.get(s.name)!),
        async writeFile(name, file, by, note) {
          person(by);
          await library.edit(name, { write: [file] }, note ?? "", await who(by));
          return library.get(name)!;
        },
        async submitFeedback(feedback, by) {
          const { report } = library.submitFeedback(feedback, await who(by));
          return { id: report.id };
        },
        seed: (starters) => library.seed(starters),
      };

      const answer = async (c: HonoContext<Env>, fn: () => unknown) => {
        try {
          return c.json((await fn()) ?? null, 200);
        } catch (e) {
          if (e instanceof Refusal) return c.json({ error: e.message }, e.status);
          throw e;
        }
      };
      const nameOf = (c: HonoContext<Env>) => decodeURIComponent(c.req.param("name") ?? "");

      const routes = (api: OpenAPIHono<Env>) => {
        const route = (method: "get" | "post" | "put" | "patch" | "delete", path: string, summary: string, description: string, request: Record<string, unknown>, handler: (c: HonoContext<Env>, input: any) => unknown) =>
          api.openapi(
            createRoute({ method, path, summary, description, security: [{ bearer: [] }], request: request as never, responses: { 200: json(Any, "Done."), ...errors } }),
            (async (c: HonoContext<Env>) => {
              const input = method === "get" || method === "delete" ? undefined : await c.req.json().catch(() => ({}));
              return answer(c, () => handler(c, input));
            }) as never,
          );

        route("get", "/", "List skills", "Every skill at its latest version: name, description, version, kind, size and cap, feedback waiting, and whether a revision waits for the person.", {}, () => library.list());
        route("get", "/search", "Search skills", "Skills whose name or description hold any word of `q`, best match first.", { query: z.object({ q: z.string(), limit: z.coerce.number().int().positive().max(50).optional() }) }, (c) =>
          library.search(c.req.query("q") ?? "", Number(c.req.query("limit") ?? 10)),
        );
        route("post", "/feedback", "Submit feedback", "A report on a skill (quote, evidence, whatChanged), an observation on a soft skill (text), or a request for a skill not yet made (text and a draft in files). Recorded with who sent it and queued for the judge; refused, with how to fix it, when the judge could not decide it.", body(z.object({ skill: z.string(), quote: z.string().optional(), evidence: z.string().optional(), whatChanged: z.string().optional(), text: z.string().optional(), files: z.array(FileSchema).optional() })), async (c, input) => {
          const { report, next } = library.submitFeedback(input, await who(c.get("caller")));
          return { id: report.id, next };
        });
        route("get", "/{name}", "Get a skill", "A skill's files at its latest version, or at `version`, with its kind, and the revision held for the person if one is.", { params: Name, query: z.object({ version: z.coerce.number().int().positive().optional() }) }, (c) => {
          const name = nameOf(c);
          const v = c.req.query("version");
          return { ...must(library.get(name, v ? Number(v) : undefined), name), pending: library.pending(name) ?? null };
        });
        route("get", "/{name}/history", "Skill history", "Every version (newest first) with the judgment that made it, and every judgment with its reasoning and the reports it decided.", { params: Name }, (c) => library.history(nameOf(c)));
        route("get", "/{name}/feedback", "Skill feedback", "Every report on the skill, newest first, with how the judge sorted it and why.", { params: Name }, (c) => library.feedback(nameOf(c)));
        route("put", "/{name}", "Edit a skill", "The person writes and removes files as a new version at once, making the skill if it is new. Person only.", { params: Name, ...body(z.object({ write: z.array(FileSchema).optional(), remove: z.array(z.string()).optional(), reason: z.string().optional() })) }, async (c, input) => {
          person(c.get("caller"));
          return library.edit(nameOf(c), input, input.reason ?? "", await who(c.get("caller")));
        });
        route("patch", "/{name}", "Configure a skill", "The person sets how a skill is judged (`kind` hard or soft), whether a revision from feedback waits for approval (`protected`), its cap (`maxChars`) and a soft skill's window (`window`); null for the default. Person only.", { params: Name, ...body(z.object({ kind: z.enum(["hard", "soft"]).optional(), protected: z.boolean().optional(), maxChars: z.number().int().nullable().optional(), window: z.number().int().nullable().optional() })) }, (c, input) => {
          person(c.get("caller"));
          return library.configure(nameOf(c), input);
        });
        route("delete", "/{name}", "Delete a skill", "Takes a skill out of the library; its history and feedback stay on record. The two judge skills cannot be deleted. Person only.", { params: Name, query: z.object({ reason: z.string().optional() }) }, async (c) => {
          person(c.get("caller"));
          return library.delete(nameOf(c), c.req.query("reason") ?? "", await who(c.get("caller")));
        });
        route("post", "/{name}/revert", "Revert a skill", "The person restores an earlier version's files as a new version. Person only.", { params: Name, ...body(z.object({ version: z.number().int(), reason: z.string().optional() })) }, async (c, input) => {
          person(c.get("caller"));
          return library.revert(nameOf(c), input.version, input.reason ?? "", await who(c.get("caller")));
        });
        route("post", "/{name}/judge", "Ask the judge", "Has the judge consider the skill now, with whatever feedback waits. The only way feedback changes the two judge skills. Person only.", { params: Name }, (c) => {
          person(c.get("caller"));
          library.judgeNow(nameOf(c));
          return { judging: true };
        });
        route("post", "/{name}/approve", "Approve a revision", "Keeps the revision the judge made of a protected skill as its next version. Person only.", { params: Name, ...body(z.object({ reason: z.string().optional() })) }, async (c, input) => {
          person(c.get("caller"));
          return library.approve(nameOf(c), input.reason ?? "", await who(c.get("caller")));
        });
        route("post", "/{name}/decline", "Decline a revision", "Discards the revision held for approval; the skill stays as it is and the decision is kept in its history. Person only.", { params: Name, ...body(z.object({ reason: z.string().optional() })) }, async (c, input) => {
          person(c.get("caller"));
          return library.decline(nameOf(c), input.reason ?? "", await who(c.get("caller")));
        });
      };

      const tools = [
        tool({ name: "list_skills", title: "List skills", description: "Every skill, with its description, version and kind.", input: {}, readOnly: true, run: () => library.list().map(({ name, description, version, kind }) => ({ name, description, version, kind })) }),
        tool({
          name: "search_skills",
          title: "Search skills",
          description: "Skills whose name or description hold any word of query, best first.",
          input: { query: z.string(), limit: z.number().int().positive().max(50).optional() },
          readOnly: true,
          run: ({ query, limit }) => library.search(query, limit ?? 10).map(({ name, description, version, kind }) => ({ name, description, version, kind })),
        }),
        tool({
          name: "get_skill",
          title: "Get a skill",
          description: `A skill's ${SKILL_FILE}, the paths of its other files, and its kind; with path, that one file instead. kind is hard for most skills; soft for one that records a person's taste, which takes observations without a quote.`,
          input: {
            name: z.string().describe("e.g. workplace/skill-writing"),
            path: z.string().optional().describe(`One file of the skill; omit for ${SKILL_FILE} and the file list.`),
            version: z.number().int().positive().optional().describe("An earlier version; omit for the latest."),
          },
          readOnly: true,
          run: ({ name, path, version }) => {
            const s = library.get(name, version);
            if (!s) throw new Refusal(version ? `${name} has no version ${version}` : `no skill is named ${name}`, 404);
            if (path) {
              const f = s.files.find((x) => x.path === path);
              if (!f) throw new Refusal(`${name} has no file ${path}`, 404);
              return f.content;
            }
            return { name, version: s.version, kind: s.kind, [SKILL_FILE]: s.files.find((f) => f.path === SKILL_FILE)?.content ?? "", files: s.files.filter((f) => f.path !== SKILL_FILE).map((f) => ({ path: f.path, executable: f.executable ?? false })) };
          },
        }),
        tool({
          name: "submit_feedback",
          title: "Submit skill feedback",
          description: `If you edited something a skill mentions, or a skill gave you wrong information, report it: quote is the skill's text exactly, evidence what shows it is wrong, what_changed what you did instead. A report missing any of these, or quoting text the skill does not have, is refused with how to fix it; resubmit it fixed. On a soft skill (get_skill says kind: soft), an observation in feedback is enough. Under a name no skill has yet, it asks for that skill: say what it is for in feedback, follow ${WRITING_SKILL} and draft its ${SKILL_FILE} in files. A judge revises skills from these reports.`,
          input: {
            skill: z.string().describe("The skill, e.g. workplace/skill-writing."),
            quote: z.string().optional().describe("The exact text in the skill that is wrong or out of date, a whole sentence or line."),
            evidence: z.string().optional().describe("What shows it: a file as it is now, or a command you ran and what it printed."),
            what_changed: z.string().optional().describe("What you did instead of what the quote says, or what you changed that it describes."),
            feedback: z.string().optional().describe("Anything else. For a new skill: what it is for. For a soft skill: your observation."),
            files: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean().optional() })).optional().describe("Files you suggest, each whole."),
          },
          run: async ({ skill, quote, evidence, what_changed, feedback, files }, caller) => {
            const { report, next } = library.submitFeedback({ skill, quote, evidence, whatChanged: what_changed, text: feedback, files }, await who(caller));
            const said: Record<typeof next, string> = {
              judging: library.get(skill) ? `Recorded. The judge is deciding it now: if your evidence shows the quoted text is wrong, ${skill} is fixed from it.` : `Recorded. The new skill ${skill} is being considered now.`,
              soft: `Recorded. ${skill} is a soft skill: your observation is held to weigh with other sessions' reports, and the skill changes once they agree on a pattern.`,
              protected: `Recorded. ${skill} is protected: a revision from feedback is kept only once the person approves it.`,
              person: `Recorded. ${skill} is the judge's own guidance, revised only when the person asks; your feedback will be there when they do.`,
              off: "Recorded. No judge runs here, so the person will read it.",
            };
            return { id: report.id, said: said[next] };
          },
        }),
      ];

      return { service, routes, tools, instructions: INSTRUCTIONS, close: () => library.idle() };
    },
  };
}

export const skills: Module = createSkills();
