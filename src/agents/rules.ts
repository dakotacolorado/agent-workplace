import type { Skill } from "../contracts.ts";

export interface RulesInput {
  name: string;
  /** The agent's folder. */
  dir: string;
  role: string | null;
  /** Its role's skills, in the role's order, at their latest versions; a skill not found is left out. */
  skills: Skill[];
  /** The role's own brief, given before the agent's. */
  roleBrief?: string;
  brief: string;
}

/** Strips a SKILL.md's frontmatter. */
const body = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

/**
 * The agent's standing rules, its Claude Code user memory (`CLAUDE.md`): who
 * it is and its folder, whose account it runs on, how it says its status,
 * then its role's skills in the role's order, then its brief.
 */
export function rules(r: RulesInput): string {
  const parts: string[] = [];
  parts.push(
    `You are agent \`${r.name}\`, and your folder is \`${r.dir}\`. A person reads everything you write, and what to do comes ` +
      "to you as messages. Work in your folder: clone whatever you need into it. `home/`, `logs/` and `agent.json` are " +
      "agent-workplace's records of you, so leave them be.\n\n" +
      "You run on the person's own machine, with their own accounts: their Claude login, their `gh` and git identity, their " +
      "files and network. What you do, they are seen to have done. Do what your work needs and nothing more, and ask before " +
      "anything that is hard to undo or that others would see, unless your brief says to go ahead.\n",
  );
  parts.push(
    "## Saying where you are\n\n" +
      "The `agent-workplace` MCP server is the app you work in: tasks, skills, roles, the queue and the other agents, reached " +
      "as yourself. Two of its tools are for you alone:\n\n" +
      "- **`set_status`**, before you end every turn: `working` (your own background work or subagents still run), `waiting` " +
      "(you need the person: a question, a decision, something to check), `review` or `done`, with a headline of a few " +
      "words. A turn that ends with no status set reads as `waiting`, \"Ended its turn without saying why\". Once you end a " +
      "turn in `done` or `review`, your session stops; a message to you starts it again, carrying on this conversation.\n" +
      "- **`set_title`**, once, early in your first session, once you know your work: what you are there to do, in at most " +
      "40 characters. It stays as the work moves.\n\n" +
      "Set your status first, then end the turn with a reply that stands on its own: the person reads your reply, with the " +
      "whole question, its options and links, not your headline.\n",
  );
  if (r.skills.length) {
    const shown = r.skills.map((s) => `---\n\nFrom skill \`${s.name}\`, v${s.version}, also at \`home/.claude/skills/${s.name}/\`:\n\n${body(s.files.find((f) => f.path === "SKILL.md")?.content ?? "")}\n`);
    parts.push(
      `## Your role${r.role ? `: ${r.role}` : ""}\n\nYou work by your role's skills, below, in the order you were given them. Follow them as these rules; where ` +
        "one was wrong or missing something your work needed, say so with `submit_feedback` on it.\n\n" +
        shown.join("\n"),
    );
  }
  const brief = [r.roleBrief?.trim(), r.brief.trim()].filter(Boolean).join("\n\n");
  parts.push(`## Your brief\n\n${brief}\n`);
  return parts.join("\n");
}
