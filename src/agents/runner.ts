/**
 * The one place the app calls the Claude Agent SDK. A session is a `query()`
 * over streaming input: what the agent is told is pushed into its input, and
 * what it says comes out as SDK messages. The rest of the module sees only
 * `SessionHandle`, so tests drive a stand-in that emits scripted messages and
 * never call Claude.
 */
import { query, type CanUseTool, type McpServerConfig, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface SessionOptions {
  /** The agent's folder. */
  cwd: string;
  /** The whole environment of the session's Claude Code: the SDK replaces the subprocess's with it. */
  env: Record<string, string>;
  /** A new conversation under this Claude Code session id... */
  sessionId?: string;
  /** ...or this one carried on. */
  resume?: string;
  mcpServers: Record<string, unknown>;
  /** The model alias it runs on. */
  model: string;
  /** Answers each tool's permission request: true to allow it, or why not. */
  permit: (tool: string) => true | string;
  /** Whatever the session writes on its stderr. */
  stderr: (text: string) => void;
}

export interface SessionHandle {
  /** Pushes a user message into the session's input: taken at once between turns, or at the next step of the turn under way. */
  send(text: string): void;
  /** Ends the session and its Claude Code. */
  close(): void;
  /** What the session says, until it ends; throws if it ends by failing. */
  events: AsyncIterable<unknown>;
}

export type StartSession = (options: SessionOptions) => SessionHandle;

/** An input that waits for the next message until it is closed. */
export class Inbox<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) throw new Error("the session's input is closed");
    this.queue.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

/** Runs a real Claude Code session, on the login its environment points at. */
export const startSdkSession: StartSession = (o) => {
  const inbox = new Inbox<SDKUserMessage>();
  const canUseTool: CanUseTool = async (tool, input) => {
    const answer = o.permit(tool);
    return answer === true ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: answer };
  };
  const q: Query = query({
    prompt: inbox,
    options: {
      cwd: o.cwd,
      env: o.env,
      ...(o.resume ? { resume: o.resume } : { sessionId: o.sessionId }),
      model: o.model,
      mcpServers: o.mcpServers as Record<string, McpServerConfig>,
      // As `claude` itself loads them: the agent's own settings and rules from its CLAUDE_CONFIG_DIR, and those of whatever it works in.
      settingSources: ["user", "project", "local"],
      // Without it the SDK sends an empty system prompt, not Claude Code's.
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool,
      permissionMode: "default",
      stderr: o.stderr,
    },
  });
  return {
    send(text) {
      inbox.push({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: text } } as SDKUserMessage);
    },
    close() {
      inbox.close();
      q.close();
    },
    events: q as AsyncIterable<unknown>,
  };
};
