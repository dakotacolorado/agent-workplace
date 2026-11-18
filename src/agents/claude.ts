/**
 * What the agents module knows of Claude Code's own shapes: the folder an
 * agent's Claude Code keeps its state in, the login it shares with the
 * person, the models each capability runs on and what they cost, and what
 * one SDK message says (lines for the transcript, a turn's start or end, the
 * tokens it used, a usage limit).
 *
 * Every agent has a Claude Code of its own -- settings, history,
 * transcripts, skills and its rules -- in `CLAUDE_CONFIG_DIR` under its
 * folder, and the person's login. HOME stays the person's: on macOS the login
 * is in their login Keychain, which a process with another HOME does not
 * search, and git, gh and ssh find their identity there too. Claude Code keys
 * its login store by `CLAUDE_CONFIG_DIR` unless `CLAUDE_SECURESTORAGE_CONFIG_DIR`
 * says where the login is, so each session is given that, set to wherever the
 * person's own Claude Code keeps it (empty: Claude Code's default store).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Capability } from "../contracts.ts";

/** Tools that wait on a person at a terminal, which a session run by the app has none of: an agent asks in words and ends its turn. */
export const DENIED = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

/** Answers a tool's permission request: true to allow it, or why not. */
export function permit(tool: string): true | string {
  return DENIED.includes(tool) ? `${tool} waits on a person at a terminal, and agent-workplace's sessions have none: ask in your reply and end your turn` : true;
}

/** A tool's input or result is shown on one line and can be a whole file: longer than this many characters, it is cut. */
export const LONGEST_TOOL_TEXT = 4096;

/** What an agent says, or is told, is kept whole up to this many characters. */
export const LONGEST_TEXT = 64 << 10;

/** The model alias each capability runs on: Claude Code resolves each to the latest of its family. */
export const MODELS: Record<Capability, string> = { 1: "haiku", 2: "sonnet", 3: "opus" };

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** US dollars per million tokens, Anthropic's list prices of 2026-11, by model family; cache writes at the 1-hour TTL, Claude Code's. */
export const PRICES: Record<"haiku" | "sonnet" | "opus", Price> = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
};

export interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const NO_TOKENS: Tokens = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/** What `tokens` of `model` cost, estimated from list prices; a model of no family known costs nothing here. */
export function cost(model: string, tokens: Tokens): number {
  const family = (["haiku", "sonnet", "opus"] as const).find((f) => model.includes(f));
  if (!family) return 0;
  const p = PRICES[family];
  return (tokens.inputTokens * p.input + tokens.outputTokens * p.output + tokens.cacheReadInputTokens * p.cacheRead + tokens.cacheCreationInputTokens * p.cacheWrite) / 1e6;
}

/**
 * The person's own `CLAUDE_CONFIG_DIR`, if they set one: where their login
 * is. One inside `agentsDir` is an agent's own state -- the app was started
 * from inside an agent's session -- and is passed over for Claude Code's
 * default.
 */
export function loginDir(configDir: string | undefined, agentsDir: string): string | null {
  if (!configDir) return null;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const dir = real(configDir);
  const agents = real(agentsDir);
  if (dir === agents || dir.startsWith(agents + sep)) return null;
  return configDir;
}

/** What Claude Code needs beside the rest of a session's environment: the agent's own state, and where the shared login is. */
export function claudeEnv(state: string, login: string | null): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: state, CLAUDE_SECURESTORAGE_CONFIG_DIR: login ?? "" };
}

/** Variables a Claude Code session sets for its own children, which would make a session the app starts think it is one of them. */
const SESSION_OWN = /^(CLAUDECODE|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_.*|CHILD_SESSION|MESSAGING_.*)|AGENT_WORKPLACE_.*)$/;

/** The app's own environment, as a session starts from it: the person's, less what belongs to a Claude Code session the app itself may run in. */
export function baseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SESSION_OWN.test(k)) out[k] = v;
  return out;
}

/**
 * Readies an agent's Claude Code state in `state` to start in `dir`: what
 * Claude Code asks a new user, or of a folder it has not seen, is answered
 * beforehand, and the tools that wait on a terminal are denied. Answers
 * already there are kept. `rules` are its standing instructions, Claude Code's
 * user memory, read at the start of every session.
 */
export function prepare(state: string, dir: string, rules: string): void {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const project = realpathSync(dir);
  merge(join(state, ".claude.json"), (config) => {
    config.hasCompletedOnboarding ??= true;
    config.hasCompletedClaudeInChromeOnboarding ??= true;
    config.claudeInChromeDefaultEnabled ??= false;
    const projects = (config.projects ??= {}) as Record<string, Record<string, unknown>>;
    if (typeof projects !== "object" || Array.isArray(projects)) throw new Error("projects is not an object");
    const entry = (projects[project] ??= {});
    if (typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${project} is not an object`);
    entry.hasTrustDialogAccepted = true;
  });
  merge(join(state, "settings.json"), (settings) => {
    const permissions = (settings.permissions ??= {}) as Record<string, unknown>;
    if (typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("permissions is not an object");
    const deny = (permissions.deny ??= []) as unknown[];
    if (!Array.isArray(deny)) throw new Error("permissions.deny is not an array");
    for (const tool of DENIED) if (!deny.includes(tool)) deny.push(tool);
  });
  writeFileSync(join(state, "CLAUDE.md"), rules);
}

/** Changes the JSON object in `path`, or a new one, written aside and renamed over, readable by this user alone. */
function merge(path: string, change: (o: Record<string, unknown>) => void): void {
  let value: unknown = {};
  if (existsSync(path)) value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: not an object`);
  const before = JSON.stringify(value);
  try {
    change(value as Record<string, unknown>);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  if (JSON.stringify(value) === before && existsSync(path)) return;
  const aside = `${path}.agent-workplace`;
  writeFileSync(aside, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(aside, 0o600);
  renameSync(aside, path);
}

// --- what a message says ------------------------------------------------------

export type LineKind = "message" | "agent" | "tool" | "result" | "notice";

export interface Said {
  kind: LineKind;
  text: string;
}

export interface Read {
  lines: Said[];
  /** Its Claude Code session id, when it is the `init` that says. */
  claudeSession?: string;
  /** True for a message that shows the agent at work in a turn (an assistant message, a tool's result). */
  working?: boolean;
  /** True for a `result`: the turn ended, however it ended. */
  turnEnded?: boolean;
  /** What its turn used by model, when it is a `result` that says. */
  byModel?: Record<string, Tokens>;
  /** When the usage limit resets, when it is a `rate_limit_event` that refuses the account. */
  limitedUntil?: string;
}

type Json = { [k: string]: unknown };
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const epoch = (s: number) => {
  const d = new Date(s < 1e12 ? s * 1000 : s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** `text` as it is when at most `longest` characters long; otherwise as much as fits, with a note of how much that is. */
export function cut(text: string, longest: number): string {
  const chars = [...text];
  if (chars.length <= longest) return text;
  return `${chars.slice(0, longest).join("")}… [cut: ${longest} of ${chars.length} characters]`;
}

function tokensOf(u: Json): Tokens {
  return {
    inputTokens: count(u.inputTokens ?? u.input_tokens),
    outputTokens: count(u.outputTokens ?? u.output_tokens),
    cacheCreationInputTokens: count(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
    cacheReadInputTokens: count(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
  };
}

/**
 * What a `result` says its turn used. `model_usage_since_last_result` is this
 * process's since its last `result`, subagents included, by model; without it
 * the main conversation's `usage` stands, under the session's own model.
 */
function turnTokens(v: Json, model: string): Record<string, Tokens> | undefined {
  const since = v.model_usage_since_last_result;
  if (since && typeof since === "object") {
    const out: Record<string, Tokens> = {};
    for (const [m, u] of Object.entries(since as Json)) out[m] = tokensOf(obj(u));
    return out;
  }
  if (v.usage && typeof v.usage === "object") return { [model]: tokensOf(obj(v.usage)) };
  return undefined;
}

function rejected(v: Json): string | undefined {
  const info = obj(v.rate_limit_info);
  if (info.status !== "rejected") return undefined;
  if (typeof info.resetsAt === "number") return epoch(info.resetsAt);
  const resets = Object.values(obj(info.unifiedWindows))
    .map(obj)
    .filter((w) => w.status === "rejected" && typeof w.resetsAt === "number")
    .map((w) => w.resetsAt as number);
  return resets.length ? epoch(Math.max(...resets)) : undefined;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(obj)
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : b.type === "tool_reference" && typeof b.tool_name === "string" ? `[tool ${b.tool_name}]` : typeof b.type === "string" ? `[${b.type}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/** What one SDK message says. `model` is the session's, for a `result` that names none. A message of a kind not read here says nothing. */
export function read(message: unknown, model: string): Read {
  const v = obj(message);
  const out: Read = { lines: [] };
  if (v.type === "rate_limit_event") {
    const until = rejected(v);
    if (until) out.limitedUntil = until;
    return out;
  }
  if (v.type === "result") {
    out.turnEnded = true;
    const t = turnTokens(v, model);
    if (t) out.byModel = t;
    if (v.is_error === true && typeof v.result === "string" && v.result) out.lines.push({ kind: "notice", text: cut(v.result, LONGEST_TEXT) });
    return out;
  }
  if (v.type === "system") {
    if (v.subtype === "init" && typeof v.session_id === "string") out.claudeSession = v.session_id;
    if (v.subtype === "compact_boundary") {
      const m = obj(v.compact_metadata);
      const how = m.trigger === "auto" ? " automatically" : "";
      const before = typeof m.pre_tokens === "number" ? ` (${Math.round(count(m.pre_tokens) / 1000)}k tokens of context)` : "";
      out.lines.push({ kind: "notice", text: `Compacted the conversation${how}${before}` });
    }
    return out;
  }
  // A subagent's own conversation, and lines Claude Code adds for itself.
  if (typeof v.parent_tool_use_id === "string" || v.isSidechain === true || v.isMeta === true) return out;
  const msg = obj(v.message);
  if (v.type === "assistant") {
    // Claude Code's own notices (a usage limit's, say) name the model `<synthetic>`: the agent is not at work.
    const synthetic = msg.model === "<synthetic>";
    if (!synthetic) out.working = true;
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      const block = obj(b);
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        out.lines.push({ kind: synthetic ? "notice" : "agent", text: cut(block.text, LONGEST_TEXT) });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        out.lines.push({ kind: "tool", text: cut(`${block.name} ${JSON.stringify(block.input ?? null)}`, LONGEST_TOOL_TEXT) });
      }
    }
    return out;
  }
  if (v.type === "user" && Array.isArray(msg.content)) {
    // Tool results come back as the user's turn; they are the agent's own work.
    for (const b of msg.content) {
      const block = obj(b);
      if (block.type !== "tool_result") continue;
      out.working = true;
      const text = resultText(block.content);
      out.lines.push({ kind: "result", text: cut(block.is_error === true ? `Error: ${text}` : text, LONGEST_TOOL_TEXT) });
    }
  }
  return out;
}
