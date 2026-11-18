import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { Caller } from "../contracts.ts";
import { tool, type Env, type Tool } from "../module.ts";
import { AgentService, Conflict, HEADLINE_LIMIT, Invalid, NAME, NotFound, TITLE_LIMIT, type Change } from "./service.ts";

const Status = z.enum(["working", "idle", "waiting", "review", "done"]);
const Said = z.enum(["working", "waiting", "review", "done"]);
const Capability = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const AgentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.string().nullable(),
    task: z.string().nullable(),
    brief: z.string(),
    capability: Capability,
    status: Status,
    headline: z.string().nullable(),
    title: z.string().nullable(),
    live: z.boolean(),
    queued: z.boolean(),
    limitedUntil: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Agent");

const TokensSchema = z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheCreationInputTokens: z.number(), cacheReadInputTokens: z.number() });
const SessionSchema = z
  .object({
    id: z.string(),
    claudeSession: z.string(),
    model: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    endReason: z.enum(["stopped", "done", "ended", "failed", "limit", "shutdown"]).nullable(),
    turns: z.number(),
    tokens: TokensSchema,
    costUsd: z.number(),
  })
  .openapi("AgentSession");
const AgentDetail = AgentSchema.extend({ sessions: z.array(SessionSchema), costUsd: z.number() }).openapi("AgentDetail");

const LineSchema = z
  .object({
    seq: z.number(),
    at: z.string(),
    sessionId: z.string().nullable(),
    kind: z.enum(["message", "agent", "tool", "result", "notice"]),
    sender: z.string().nullable(),
    text: z.string(),
  })
  .openapi("TranscriptLine");
const LinesSchema = z.object({ lines: z.array(LineSchema), next: z.number() }).openapi("TranscriptLines");
const ErrorSchema = z.object({ error: z.string() });

const NewAgentSchema = z.object({
  name: z.string().regex(NAME).describe("Unique; its folder is `agents/<name>/` in the data folder."),
  role: z.string().optional().describe("The role whose skills it works by; absent, none."),
  task: z.string().optional().describe("The task id or short id it works on; it becomes the task's assignee and moves it `in_progress`."),
  brief: z.string().min(1).describe("What it is to do: its first message, and the end of its rules."),
  capability: Capability.optional().describe("1 Haiku, 2 Sonnet, 3 Opus; absent, the role's, or 3."),
});
const MessageSchema = z.object({ text: z.string().min(1) });
const StatusBody = z.object({ status: Said, headline: z.string().max(HEADLINE_LIMIT) });
const TitleBody = z.object({ title: z.string().min(1).max(TITLE_LIMIT) });
const IdParam = z.object({ id: z.string().describe("The agent's id or name.") });
const CursorQuery = z.object({
  after: z.coerce.number().int().min(0).optional().describe("Lines after this `seq`; absent or 0, from the start."),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(ErrorSchema, "What is wrong with the request."),
  404: json(ErrorSchema, "No such agent."),
  409: json(ErrorSchema, "Refused as things stand."),
};
const security = [{ bearer: [] }];

/** The HTTP status an error answers with. */
function statusOf(err: unknown): 400 | 404 | 409 {
  if (err instanceof NotFound) return 404;
  if (err instanceof Invalid) return 400;
  return 409;
}

/** The agent a status or title is set for: the calling agent itself, or for the person, the one named. */
function target(svc: AgentService, caller: Caller, named: string | undefined): string {
  if (caller.kind === "agent") {
    if (named && svc.idOf(named) !== caller.agentId) throw new Conflict("an agent sets only its own status and title");
    return caller.agentId;
  }
  if (!named) throw new Invalid("name the agent");
  return named;
}

function detail(svc: AgentService, id: string) {
  const sessions = svc.sessions(id);
  return { sessions, costUsd: sessions.reduce((n, s) => n + s.costUsd, 0) };
}

export function routes(svc: AgentService) {
  return (api: OpenAPIHono<Env>) => {
    api.onError((err, c) => c.json({ error: err.message }, statusOf(err)));

    api.openapi(
      createRoute({
        method: "get",
        path: "/",
        summary: "List agents",
        description: "Every agent, open and closed, oldest first, with its status, headline and title.",
        security,
        responses: { 200: json(z.object({ agents: z.array(AgentSchema) }), "The agents.") },
      }),
      async (c) => c.json({ agents: await svc.list() }, 200),
    );

    api.openapi(
      createRoute({
        method: "post",
        path: "/",
        summary: "Create agent",
        description:
          "Makes an agent and asks for its first session, told its brief. The session starts at once when fewer than `AGENT_WORKPLACE_MAX_AGENTS` run, otherwise once there is room, highest role priority first.",
        security,
        request: { body: { content: { "application/json": { schema: NewAgentSchema } }, required: true } },
        responses: { 201: json(AgentSchema, "The agent."), ...errors },
      }),
      async (c) => c.json(await svc.create(c.req.valid("json"), c.get("caller")), 201),
    );

    api.openapi(
      createRoute({
        method: "get",
        path: "/events",
        summary: "Follow agents",
        description:
          "A server-sent event stream: an `agent` event with the agent whenever one changes (status, headline, title, session), and a `line` event `{agentId, line}` for every transcript line said.",
        security,
        responses: { 200: { description: "The stream.", content: { "text/event-stream": { schema: z.string() } } } },
      }),
      (c) => feed(c, svc, () => true) as never,
    );

    api.openapi(
      createRoute({
        method: "get",
        path: "/{id}",
        summary: "Get agent",
        description: "One agent, with its sessions (start, end, why it ended, turns, tokens and estimated cost).",
        security,
        request: { params: IdParam },
        responses: { 200: json(AgentDetail, "The agent."), 404: errors[404] },
      }),
      async (c) => {
        const a = await svc.get(c.req.valid("param").id);
        if (!a) return c.json({ error: `no agent ${c.req.valid("param").id}` }, 404);
        return c.json({ ...a, ...detail(svc, a.id) }, 200);
      },
    );

    api.openapi(
      createRoute({
        method: "post",
        path: "/{id}/messages",
        summary: "Send message",
        description:
          "Tells the agent `text` as its next turn: its live session takes it at once, or at its next step; with none live, a session starts that carries on its conversation. Reopens a closed agent.",
        security,
        request: { params: IdParam, body: { content: { "application/json": { schema: MessageSchema } }, required: true } },
        responses: { 202: json(AgentSchema, "Delivered, or waiting for its session to start."), ...errors },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await svc.send(id, c.req.valid("json").text, c.get("caller"));
        return c.json((await svc.get(id))!, 202);
      },
    );

    api.openapi(
      createRoute({
        method: "post",
        path: "/{id}/stop",
        summary: "Stop agent",
        description: "Ends its live session and any waiting to start. The agent stays; a message starts it again.",
        security,
        request: { params: IdParam },
        responses: { 200: json(AgentSchema, "Stopped."), 404: errors[404] },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await svc.stop(id);
        return c.json((await svc.get(id))!, 200);
      },
    );

    api.openapi(
      createRoute({
        method: "post",
        path: "/{id}/close",
        summary: "Close agent",
        description: "Stops it and marks it closed, out of the open list; a message reopens it.",
        security,
        request: { params: IdParam },
        responses: { 200: json(AgentSchema, "Closed."), 404: errors[404] },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await svc.close(id);
        return c.json((await svc.get(id))!, 200);
      },
    );

    api.openapi(
      createRoute({
        method: "delete",
        path: "/{id}",
        summary: "Delete agent",
        description: "Stops it and removes it: its record, tokens, transcript and folder.",
        security,
        request: { params: IdParam },
        responses: { 204: { description: "Deleted." }, 404: errors[404] },
      }),
      async (c) => {
        await svc.delete(c.req.valid("param").id);
        return c.body(null, 204);
      },
    );

    api.openapi(
      createRoute({
        method: "put",
        path: "/{id}/status",
        summary: "Set status",
        description: "What the agent says of itself: `working`, `waiting` (it needs the person), `review` or `done`, with a headline. An agent sets its own; the person, any.",
        security,
        request: { params: IdParam, body: { content: { "application/json": { schema: StatusBody } }, required: true } },
        responses: { 200: json(AgentSchema, "The agent."), ...errors },
      }),
      (c) => {
        const body = c.req.valid("json");
        return c.json(svc.setStatus(target(svc, c.get("caller"), c.req.valid("param").id), body.status, body.headline), 200);
      },
    );

    api.openapi(
      createRoute({
        method: "put",
        path: "/{id}/title",
        summary: "Set title",
        description: "What the agent is there to do, at most 40 characters. An agent sets its own once (409 after); the person changes any.",
        security,
        request: { params: IdParam, body: { content: { "application/json": { schema: TitleBody } }, required: true } },
        responses: { 200: json(AgentSchema, "The agent."), ...errors },
      }),
      (c) => c.json(svc.setTitle(target(svc, c.get("caller"), c.req.valid("param").id), c.req.valid("json").title, c.get("caller")), 200),
    );

    api.openapi(
      createRoute({
        method: "get",
        path: "/{id}/transcript",
        summary: "Read transcript",
        description: "Its transcript lines after the cursor `after`, oldest first: every message it was told, what it said, each tool call and what it answered. Read on from `next`.",
        security,
        request: { params: IdParam, query: CursorQuery },
        responses: { 200: json(LinesSchema, "The lines."), 404: errors[404] },
      }),
      (c) => {
        const q = c.req.valid("query");
        return c.json(svc.lines(c.req.valid("param").id, q.after, q.limit), 200);
      },
    );

    api.openapi(
      createRoute({
        method: "get",
        path: "/{id}/transcript/stream",
        summary: "Follow transcript",
        description: "A server-sent event stream of its transcript: every `line` after `after` first, then each as it is said, and an `agent` event whenever the agent changes.",
        security,
        request: { params: IdParam, query: CursorQuery },
        responses: { 200: { description: "The stream.", content: { "text/event-stream": { schema: z.string() } } }, 404: errors[404] },
      }),
      (c) => {
        const id = svc.idOf(c.req.valid("param").id);
        return feed(c, svc, (ch) => (ch.type === "agent" ? ch.agent.id : ch.agentId) === id, { id, after: c.req.valid("query").after ?? 0 }) as never;
      },
    );
  };
}

/** Streams changes `wanted` as server-sent events; with `backlog`, that agent's lines after the cursor first. */
function feed(c: Parameters<typeof streamSSE>[0], svc: AgentService, wanted: (ch: Change) => boolean, backlog?: { id: string; after: number }) {
  return streamSSE(c, async (stream) => {
    const queue: Change[] = [];
    let wake: (() => void) | null = null;
    const unwatch = svc.watch((ch) => {
      if (!wanted(ch)) return;
      queue.push(ch);
      wake?.();
    });
    stream.onAbort(() => {
      unwatch();
      wake?.();
    });
    // Lines said while the backlog is read are both read and queued: each is sent once.
    let last = 0;
    if (backlog) {
      last = backlog.after;
      for (;;) {
        const page = svc.lines(backlog.id, last, 1000);
        for (const line of page.lines) await stream.writeSSE({ event: "line", id: String(line.seq), data: JSON.stringify({ agentId: backlog.id, line }) });
        last = page.next;
        if (page.lines.length < 1000) break;
      }
    }
    while (!stream.aborted) {
      const ch = queue.shift();
      if (!ch) {
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 15_000).unref();
        });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
        continue;
      }
      if (ch.type === "line") {
        // A line said while the backlog was read is sent once.
        if (ch.line.seq <= last) continue;
        await stream.writeSSE({ event: "line", id: String(ch.line.seq), data: JSON.stringify({ agentId: ch.agentId, line: ch.line }) });
      } else {
        await stream.writeSSE({ event: "agent", data: JSON.stringify(ch.agent) });
      }
    }
    unwatch();
  });
}

export function tools(svc: AgentService): Tool[] {
  const one = async (id: string) => {
    const a = await svc.get(id);
    if (!a) throw new NotFound(`no agent ${id}`);
    return a;
  };
  return [
    tool({
      name: "create_agent",
      title: "Create agent",
      description:
        "Makes an agent that runs a Claude Code session in its own folder, told `brief`. On a task, it becomes the task's assignee and moves it in_progress. Its session starts once fewer than the limit run.",
      input: NewAgentSchema.shape,
      run: (args, caller) => svc.create(args, caller),
    }),
    tool({
      name: "send_message",
      title: "Send message",
      description: "Tells an agent `text` as its next turn; with no live session, one starts that carries on its conversation. Reopens a closed agent.",
      input: { agent: z.string().describe("The agent's id or name."), text: z.string().min(1) },
      run: async ({ agent, text }, caller) => {
        await svc.send(agent, text, caller);
        return one(agent);
      },
    }),
    tool({
      name: "stop_agent",
      title: "Stop agent",
      description: "Ends an agent's live session and any waiting to start; the agent stays, and a message starts it again.",
      input: { agent: z.string().describe("The agent's id or name.") },
      run: async ({ agent }) => {
        await svc.stop(agent);
        return one(agent);
      },
    }),
    tool({
      name: "list_agents",
      title: "List agents",
      description: "Every agent with its status (working, idle, waiting, review, done), headline, title, role and task.",
      input: {},
      readOnly: true,
      run: async () => ({ agents: await svc.list() }),
    }),
    tool({
      name: "get_agent",
      title: "Get agent",
      description: "One agent by id or name, with its sessions: start, end, why it ended, turns, tokens and estimated cost.",
      input: { agent: z.string().describe("The agent's id or name.") },
      readOnly: true,
      run: async ({ agent }) => {
        const a = await one(agent);
        return { ...a, ...detail(svc, a.id) };
      },
    }),
    tool({
      name: "list_transcript_lines",
      title: "Read transcript",
      description:
        "An agent's transcript lines after the cursor `after` (0 or absent: from the start), oldest first: messages it was told, what it said, tool calls and their results. Read on from `next`.",
      input: { agent: z.string().describe("The agent's id or name."), after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
      readOnly: true,
      run: ({ agent, after, limit }) => svc.lines(agent, after, limit),
    }),
    tool({
      name: "set_status",
      title: "Set status",
      description:
        "Says where you are, before you end every turn: `working` (your own background work still runs), `waiting` (you need the person), `review` or `done`, with a headline of a few words. A turn ended with none set reads as waiting. Ending a turn in done or review stops your session until a message comes.",
      input: { status: Said, headline: z.string().max(HEADLINE_LIMIT), agent: z.string().optional().describe("For the person only: the agent it is for.") },
      run: ({ status, headline, agent }, caller) => svc.setStatus(target(svc, caller, agent), status, headline),
    }),
    tool({
      name: "set_title",
      title: "Set title",
      description: "Names what you are there to do, at most 40 characters, once, early in your first session. Only the person changes it after.",
      input: { title: z.string().min(1).max(TITLE_LIMIT), agent: z.string().optional().describe("For the person only: the agent it is for.") },
      run: ({ title, agent }, caller) => svc.setTitle(target(svc, caller, agent), title, caller),
    }),
  ];
}
