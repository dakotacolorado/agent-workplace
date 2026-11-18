import { randomUUID } from "node:crypto";
import type { SkillFile } from "../contracts.ts";

export const SKILL_FILE = "SKILL.md";
/** The most text a skill may hold, all its files together, unless the person sets another on it. */
export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_FILES = 100;
/** How the judge decides a hard skill: never deleted, revised only when the person asks. */
export const HARD_JUDGE = "workplace/hard-skill-judge";
/** How the judge decides a soft skill, on patterns across reports: never deleted, revised only when the person asks. */
export const SOFT_JUDGE = "workplace/soft-skill-judge";
export const isJudgeSkill = (name: string) => name === HARD_JUDGE || name === SOFT_JUDGE;
/** How to write a new skill: agents read it before drafting one, and the judge holds new skills to it. */
export const WRITING_SKILL = "workplace/skill-writing";
/** Who the judge's notes on its own guidance are recorded as written by. */
export const JUDGE_AUTHOR = "the judge";
/** Failed judgments in a row before a skill waits for new feedback. */
export const JUDGMENT_ATTEMPTS = 3;
/** Past judgments on a skill the judge is shown, to stay consistent with itself. */
export const PRECEDENT = 5;
/** The reports a soft skill's judgment sees, unless the person sets another number on it. */
export const DEFAULT_WINDOW = 20;
/** The fewest characters a quote may have: a fragment matches too much to say which text is wrong. */
export const MIN_QUOTE = 10;
/** The most a report's evidence may hold. */
export const MAX_EVIDENCE = 20_000;

/** hard: facts an agent can check, each report decided at once. soft: a person's taste, judged on patterns across reports. */
export type SkillKind = "hard" | "soft";
/** accepted (acted on), declined (closed), or, on a soft skill only, held to weigh with later reports. */
export type Sort = "accepted" | "declined" | "held";

/** A request refused for a reason the caller can fix; `status` is its HTTP status. */
export class Refusal extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();

const PART = "[a-z0-9]+(?:-[a-z0-9]+)*";
const NAME = new RegExp(`^(?:${PART}/)?${PART}$`);

/** A skill's name: its own, optionally under one namespace that groups it (`workplace/skill-writing`). */
export function checkName(name: string): string {
  if (!NAME.test(name) || name.split("/").some((p) => p.length > 64)) {
    throw new Refusal(`"${name}" must be lowercase letters, digits and single hyphens, optionally under one namespace like workplace/, at most 64 characters a part`);
  }
  return name;
}

/** The part after the namespace: what a SKILL.md's frontmatter names, since Claude Code's skill names have no slash. */
export const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1);

export function checkPath(path: string): string {
  const parts = path.split("/");
  if (path.length === 0 || path.length > 200 || path.startsWith("/") || path.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Refusal(`file path "${path}" must be relative, inside the skill, with no empty, "." or ".." parts`);
  }
  return path;
}

const sorted = (files: SkillFile[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));

/** The files after writing `writes` over `before` and deleting `remove`. */
export function applyFiles(before: SkillFile[], writes: SkillFile[], remove: string[] = []): SkillFile[] {
  const files = new Map(before.map((f) => [f.path, f]));
  for (const path of remove) if (!files.delete(checkPath(path))) throw new Refusal(`cannot remove ${path}: the skill has no such file`);
  const paths = writes.map((w) => checkPath(w.path));
  if (new Set(paths).size !== paths.length) throw new Refusal("a path is written more than once");
  for (const w of writes) files.set(w.path, { path: w.path, content: w.content, ...(w.executable ? { executable: true } : {}) });
  return sorted([...files.values()]);
}

/** One change to a file's text: `old`, found once in the file, becomes `new`. */
export interface TextEdit {
  path: string;
  old: string;
  new: string;
}

/** The files after each edit in turn, refusing one whose old text is not in its file exactly once. */
export function applyEdits(before: SkillFile[], edits: TextEdit[]): SkillFile[] {
  const files = new Map(before.map((f) => [f.path, { ...f }]));
  edits.forEach((e, i) => {
    const which = `edit ${i + 1} (on ${e.path})`;
    const file = files.get(checkPath(e.path));
    if (!file) throw new Refusal(`${which}: the skill has no such file; to make a file, write it whole`);
    if (!e.old) throw new Refusal(`${which}: its old text is empty; name the text it replaces`);
    const at = file.content.indexOf(e.old);
    if (at < 0) throw new Refusal(`${which}: its old text is not in the file; copy it exactly from the current file: "${e.old.slice(0, 200)}"`);
    if (file.content.indexOf(e.old, at + 1) >= 0) throw new Refusal(`${which}: its old text appears more than once in the file; include more around it: "${e.old.slice(0, 200)}"`);
    file.content = file.content.slice(0, at) + e.new + file.content.slice(at + e.old.length);
  });
  return sorted([...files.values()]);
}

export const textSize = (files: { content: string }[]) => files.reduce((n, f) => n + f.content.length, 0);

/** The `name` and `description` of a SKILL.md's frontmatter. */
export function frontmatter(skillMd: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  const out: { name?: string; description?: string } = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const m = /^(name|description):\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1] as "name" | "description"] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** A SKILL.md without its frontmatter. */
export const body = (skillMd: string) => skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

export const descriptionOf = (files: SkillFile[]) => frontmatter(files.find((f) => f.path === SKILL_FILE)?.content ?? "").description ?? "";

/**
 * Refuses files a skill cannot be: no SKILL.md naming it and saying what it is for, too many files, or over its cap.
 * A skill already over its cap (the person lowered it) may still change if the change makes it smaller.
 */
export function checkSkill(name: string, files: SkillFile[], maxChars: number, before?: number): void {
  const skillMd = files.find((f) => f.path === SKILL_FILE);
  if (!skillMd) throw new Refusal(`a skill must have a ${SKILL_FILE}`);
  const fm = frontmatter(skillMd.content);
  if (fm.name !== baseName(name)) throw new Refusal(`${SKILL_FILE}'s frontmatter must say name: ${baseName(name)}${name.includes("/") ? " (the part after the namespace)" : ""}`);
  if (!fm.description) throw new Refusal(`${SKILL_FILE}'s frontmatter must have a description`);
  if (files.length > MAX_FILES) throw new Refusal(`a skill holds at most ${MAX_FILES} files`);
  const size = textSize(files);
  if (size > maxChars && !(before !== undefined && size < before)) throw new Refusal(`the skill would hold ${size} characters, over its cap of ${maxChars}: condense it`);
}

/** Text with every run of whitespace made one space, so a quote matches across line breaks and indentation. */
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
/** Whether `quote` appears word for word in any of `files`, whitespace aside. */
export const quoted = (quote: string, files: { content: string }[]) => files.some((f) => squash(f.content).includes(squash(quote)));

/** Whether two sets of a skill's files are the same, path, text and executable bit. */
export const sameFiles = (a: SkillFile[], b: SkillFile[]) => {
  const key = (files: SkillFile[]) => JSON.stringify(sorted(files).map((f) => [f.path, f.content, f.executable === true]));
  return key(a) === key(b);
};
