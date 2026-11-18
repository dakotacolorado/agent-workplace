import { z } from "zod";
import type { Capability, Role, Skill } from "../contracts.ts";

export const PREFIX = "roles/";
export const ROLE_FILE = "role.json";
export const SKILL_FILE = "SKILL.md";

export class RoleRefusal extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const checkRoleName = (name: string): string => {
  if (!NAME.test(name) || name.length > 64) throw new RoleRefusal(`"${name}" must be lowercase letters, digits and single hyphens, at most 64 characters`);
  return name;
};

/** The fields of `role.json`, none defaulted: what a write may give. */
export const RoleFields = z.object({
  summary: z.string().trim().min(1).describe("What the role is for, in a line: the description of its skill."),
  skills: z.array(z.string().min(1)).describe("Other skills its agents are given, after the role's own."),
  priority: z.number().int().min(0).max(100).describe("0 to 100; higher runs first when the queue has more ready work than room."),
  capability: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe("How capable a model its agents need: 1 easy, 2 medium, 3 hard."),
  brief: z.string().nullable().describe("The first message an agent of this role starts with unless it is given its own; null for none."),
  whenDone: z.enum(["stop", "keep"]).describe("Whether an agent's session stops or is kept when its task is done."),
});

/** What `role.json` holds: the fields, with a default for each but the summary. */
export const RoleSettingsSchema = RoleFields.extend({
  skills: RoleFields.shape.skills.default([]),
  priority: RoleFields.shape.priority.default(50),
  capability: RoleFields.shape.capability.default(2),
  brief: RoleFields.shape.brief.default(null),
  whenDone: RoleFields.shape.whenDone.default("stop"),
});
export type RoleSettings = z.infer<typeof RoleSettingsSchema>;

const line = (s: string) => s.replace(/\s+/g, " ").trim();

/** A SKILL.md for the role: frontmatter naming it and saying what it is for, then the text the agent is told. */
export const skillMd = (name: string, summary: string, text: string) => `---\nname: ${name}\ndescription: ${JSON.stringify(line(summary))}\n---\n\n${text.trim()}\n`;

/** The text of a SKILL.md without its frontmatter. */
export const bodyOf = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

/** The role a skill holds, or the reason it is not one. */
export function readRole(skill: Skill): { role: Role; settings: RoleSettings } | { invalid: string } {
  if (!skill.name.startsWith(PREFIX)) return { invalid: "not under roles/" };
  const name = skill.name.slice(PREFIX.length);
  if (!NAME.test(name)) return { invalid: `"${name}" is not a role name (lowercase letters, digits and single hyphens)` };
  const file = skill.files.find((f) => f.path === ROLE_FILE);
  if (!file) return { invalid: `no ${ROLE_FILE}` };
  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch (e) {
    return { invalid: `${ROLE_FILE} is not JSON: ${(e as Error).message}` };
  }
  const parsed = RoleSettingsSchema.safeParse(raw);
  if (!parsed.success) return { invalid: `${ROLE_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}` };
  const s = parsed.data;
  const md = skill.files.find((f) => f.path === SKILL_FILE);
  if (!md) return { invalid: `no ${SKILL_FILE}` };
  const role: Role = {
    name,
    description: s.summary,
    skills: [skill.name, ...s.skills.filter((x) => x !== skill.name)],
    priority: s.priority,
    capability: s.capability as Capability,
    brief: s.brief ?? "",
    whenDone: s.whenDone,
    instructions: bodyOf(md.content),
  };
  return { role, settings: s };
}

/** Highest priority first, then by name. */
export const byPriority = (a: Role, b: Role) => b.priority - a.priority || a.name.localeCompare(b.name);
