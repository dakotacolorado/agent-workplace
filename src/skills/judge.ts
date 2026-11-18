import { query as sdkQuery, type Options as SdkOptions, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { SkillFile } from "../contracts.ts";
import { JUDGE_CONTRACT, SOFT_CONTRACT } from "./contract.ts";
import { HARD_JUDGE, SOFT_JUDGE, textSize, type SkillKind } from "./domain.ts";
import type { Judgment, Report } from "./store.ts";

const sortedOf = (kinds: [string, ...string[]], what: string) =>
  z
    .array(
      z.object({
        report: z.string().describe("The report's id, from <feedback id=…>."),
        kind: z.enum(kinds),
        why: z.string().describe("In a sentence: what decided it."),
      }),
    )
    .describe(what);

const fields = {
  reasoning: z.string().describe("Why you decided as you did, citing the feedback that decided it."),
  changed: z.boolean().describe("true if you are writing a new version of the skill."),
  note: z.string().describe("For a new version: one line for the skill's history. Empty otherwise."),
  edits: z
    .array(z.object({ path: z.string(), old: z.string(), new: z.string() }))
    .describe("Each change to a file's text, `old` copied exactly from the current file (appearing once in it). Applied before write and remove. Empty otherwise."),
  write: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })).describe("Each file to write whole. Empty otherwise."),
  remove: z.array(z.string()).describe("Each file to delete. Empty otherwise."),
  revert_to: z.number().int().describe("The earlier version to restore whole instead of editing; 0 otherwise."),
  judge_feedback: z.string().describe("Feedback on your own guidance; empty when nothing, and always empty when the skill is a judge skill."),
};

const HardDecision = z.object({
  ...fields,
  sorted: sortedOf(["accepted", "declined"], "Every report (feedback with a <quote>) decided, each once, now: accepted or declined."),
});
const SoftDecision = z.object({
  ...fields,
  sorted: sortedOf(["accepted", "declined", "held"], "Every new report in the window decided, and any held one you now accept or decline. A held report left out stays held."),
});
/** A decision as the app reads it back; a held report on a hard skill is refused when it is applied. */
export const DecisionSchema = SoftDecision;
export type Decision = z.infer<typeof DecisionSchema>;

/** The decision's JSON Schema, without the `$schema` key Claude Code's structured output refuses. */
export function decisionJsonSchema(kind: SkillKind): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(kind === "soft" ? SoftDecision : HardDecision) as Record<string, unknown>;
  return schema;
}

/** Everything the judge decides on, for one skill. */
export interface Case {
  skill: string;
  version: number;
  kind: SkillKind;
  maxChars: number;
  files: SkillFile[];
  others: { name: string; description: string }[];
  /** On a hard skill, the feedback no judgment has considered; on a soft skill, its window. */
  feedback: Report[];
  /** For a soft skill, the most reports its window holds. */
  window: number;
  precedent: (Judgment & { feedback: Report[] })[];
  /** The person asked for this judgment: the skill is judged now, whatever is waiting. */
  asked: boolean;
  /** Why the judge's last attempt at this same case was refused, for it to correct. */
  failure: string | null;
  /** The body of the judge skill for this kind. */
  guidance: string;
  /** For a skill that does not exist yet: the body of workplace/skill-writing. */
  writingGuide: string | null;
}

/** What decides a case. The app runs Claude through the Agent SDK; tests give a fake. */
export interface Judge {
  decide(c: Case): Promise<Decision>;
}

const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const file = (f: SkillFile) => `<file path="${attr(f.path)}"${f.executable ? ' executable="true"' : ""}>\n${f.content}\n</file>`;

/** The case as the judge reads it. Everything agents wrote is inside tags, as data. */
export function render(c: Case): string {
  const soft = c.kind === "soft";
  const feedback = c.feedback
    .map((f) =>
      [
        `<feedback id="${f.id.slice(0, 8)}" by="${attr(f.author)}" on_version="${f.version}" at="${f.at}"${soft && f.sort ? ` sorted_before="${f.sort}"` : ""}>`,
        ...(f.quote !== null ? [`<quote>\n${f.quote}\n</quote>`] : []),
        ...(f.evidence !== null ? [`<evidence>\n${f.evidence}\n</evidence>`] : []),
        ...(f.whatChanged !== null ? [`<what_changed>\n${f.whatChanged}\n</what_changed>`] : []),
        ...(f.text ? [f.quote !== null ? `<also_said>\n${f.text}\n</also_said>` : f.text] : []),
        ...(f.files.length ? [`<draft>\n${f.files.map(file).join("\n")}\n</draft>`] : []),
        "</feedback>",
      ].join("\n"),
    )
    .join("\n\n");
  const precedent = c.precedent
    .map((j) => {
      const from = j.feedback.map((f) => `<from report="${f.id.slice(0, 8)}" by="${attr(f.author)}">${f.quote !== null ? `quoting: ${f.quote}` : f.text.slice(0, 300)}</from>`);
      return `<judgment at="${j.startedAt}" changed="${j.changed}"${j.version ? ` made_version="${j.version}"` : ""} reports="${j.feedback.length}">\n${[...from, j.reasoning].join("\n")}\n</judgment>`;
    })
    .join("\n");
  return [
    `<skill name="${c.skill}" version="${c.version}" characters="${textSize(c.files)}" cap="${c.maxChars}"${soft ? ` kind="soft" window="${c.window}"` : ""}>\n${c.files.map(file).join("\n") || "none: the skill does not exist yet"}\n</skill>`,
    `<other_skills>\n${c.others.map((o) => `<skill name="${attr(o.name)}">${o.description}</skill>`).join("\n") || "none"}\n</other_skills>`,
    ...(c.writingGuide ? [`<skill_writing_guide>\n${c.writingGuide}\n</skill_writing_guide>`] : []),
    ...(c.asked ? ["<the_person_asked_for_this_judgment>\nThe person asked for it: judge the skill now, with whatever feedback is waiting. Decide every report still.\n</the_person_asked_for_this_judgment>"] : []),
    soft
      ? `<window reports="${c.feedback.length}" new="${c.feedback.filter((f) => f.sort === null).length}" held="${c.feedback.filter((f) => f.sort === "held").length}" authors="${new Set(c.feedback.map((f) => f.author)).size}">\n${feedback || "none"}\n</window>`
      : `<new_feedback>\n${feedback || "none"}\n</new_feedback>`,
    `<your_recent_judgments_on_this_skill>\n${precedent || "none"}\n</your_recent_judgments_on_this_skill>`,
    ...(c.failure ? [`<your_last_attempt_was_refused>\n${c.failure}\n</your_last_attempt_was_refused>`] : []),
  ].join("\n\n");
}

/** The fixed brief, then the judge skill's guidance; for a soft skill, the soft section and the soft judge's guidance. */
export const systemPrompt = (guidance: string, kind: SkillKind) =>
  kind === "soft"
    ? `${JUDGE_CONTRACT}\n${SOFT_CONTRACT}\n# Your guidance (the ${SOFT_JUDGE} skill)\n\n${guidance.trim()}\n`
    : `${JUDGE_CONTRACT}\n# Your guidance (the ${HARD_JUDGE} skill)\n\n${guidance.trim()}\n`;

/** The Agent SDK's `query`, or a stand-in. */
export type AgentQuery = (params: { prompt: string; options: SdkOptions }) => AsyncIterable<SDKMessage>;

export interface ClaudeJudgeOptions {
  /** A model to ask for; Claude Code's default otherwise. */
  model?: string;
  timeoutMs?: number;
  /** What to call instead of the Agent SDK (tests). */
  query?: AgentQuery;
}

/**
 * Decides with one headless Claude Code session per case, through the Claude Agent SDK, signed in as Claude Code is on
 * this machine (its login, or `CLAUDE_CODE_OAUTH_TOKEN`): no tools, no settings, no MCP servers, nothing kept.
 */
export class ClaudeJudge implements Judge {
  private model: string | undefined;
  private timeoutMs: number;
  private query: AgentQuery;

  constructor(opts: ClaudeJudgeOptions = {}) {
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    // Tests never call Claude: under vitest the real Agent SDK is never reached, whatever a test forgets to fake.
    this.query = opts.query ?? (process.env.VITEST ? () => { throw new Error("tests never call Claude: give the judge a fake"); } : sdkQuery);
  }

  async decide(c: Case): Promise<Decision> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let stderr = "";
    const options: SdkOptions = {
      abortController: abort,
      cwd: tmpdir(),
      systemPrompt: systemPrompt(c.guidance, c.kind),
      outputFormat: { type: "json_schema", schema: decisionJsonSchema(c.kind) },
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      ...(this.model ? { model: this.model } : {}),
      stderr: (d) => (stderr = (stderr + d).slice(-2000)),
    };
    try {
      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      for await (const m of this.query({ prompt: render(c), options })) if (m.type === "result") result = m;
      if (abort.signal.aborted) throw new Error("aborted");
      if (!result) throw new Error("the session ended without a result");
      if (result.subtype !== "success") throw new Error(result.errors.join("; ") || result.subtype);
      if (result.is_error) throw new Error(result.result || "the judge's session failed");
      return DecisionSchema.parse(result.structured_output);
    } catch (e) {
      if (abort.signal.aborted) throw new Error(`the judge did not decide within ${this.timeoutMs / 1000}s`);
      throw new Error(`the judge gave no decision: ${e instanceof Error ? e.message : String(e)}${stderr.trim() ? `; ${stderr.trim().slice(0, 500)}` : ""}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
