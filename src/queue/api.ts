import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { tool, type Env, type Tool } from "../module.ts";
import { Conflict, Invalid, MAX_LIMIT, type QueueService } from "./service.ts";

const security = [{ bearer: [] }];
const EntrySchema = z
  .object({
    taskId: z.string(),
    position: z.number(),
    role: z.string(),
    state: z.enum(["queued", "started", "finished", "dropped"]),
    note: z.string().nullable().describe("Why it waits, or why it was dropped."),
    queuedBy: z.string(),
    agentName: z.string().nullable(),
    queuedAt: z.string(),
    startedAt: z.string().nullable(),
  })
  .openapi("QueueEntry");
const StateSchema = z.object({ limit: z.number(), entries: z.array(EntrySchema) }).openapi("QueueState");
const ErrorSchema = z.object({ error: z.string() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorSchema, "The request is wrong."), 409: json(ErrorSchema, "The queue refuses it; `error` says why.") };
const QueueInput = z.object({
  taskId: z.string().min(1).describe("The task's id or short id."),
  role: z.string().optional().describe("The role of the agent started on it. Default implementer."),
  before: z.string().optional().describe("A queued task to go in front of. Default: the back."),
});
const LimitInput = z.object({ limit: z.number().int().min(0).max(MAX_LIMIT).describe("How many queued tasks may run at once; 0 pauses the queue.") });

const state = (q: QueueService) => ({ limit: q.limit, entries: q.list() });
const statusOf = (err: Error) => (err instanceof Conflict ? 409 : err instanceof Invalid ? 400 : 500);

export const INSTRUCTIONS = `queue: for agents that manage a plan. Queue its tasks (queue_task) and an agent is started on each, in queue order, once the task is ready (open, nothing it depends on still open, nobody assigned) and fewer than the limit run. Until then list_queue says why each entry waits. A task counts against the limit until it is done or cancelled. The agent's capability follows the task's metadata.difficulty. set_limit 0 pauses the queue; a higher limit spends more tokens. The queue looks every 30 seconds, and when a task closes, a session ends, or queue_task, dequeue_task or set_limit is called; tick looks at once.`;

export function routes(q: QueueService) {
  return (api: OpenAPIHono<Env>) => {
    api.onError((err, c) => {
      if (err instanceof Conflict || err instanceof Invalid) return c.json({ error: err.message }, statusOf(err));
      console.error(err);
      return c.json({ error: "internal error" }, 500);
    });
    api.openapi(
      createRoute({ method: "get", path: "/", summary: "List queue", description: "The limit and every entry: queued ones first in order, then started, finished and dropped, each with its state and why it waits.", security, responses: { 200: json(StateSchema, "The queue.") } }),
      (c) => c.json(state(q), 200),
    );
    api.openapi(
      createRoute({ method: "post", path: "/", summary: "Queue task", description: "Queues a task at the back, or before another queued one; queuing it again moves it. An agent is started on it once it is ready and there is room under the limit.", security, request: { body: { content: { "application/json": { schema: QueueInput } }, required: true } }, responses: { 201: json(EntrySchema, "The entry."), ...errors } }),
      async (c) => {
        const { taskId, ...options } = c.req.valid("json");
        return c.json(await q.queue(taskId, c.get("caller"), options), 201);
      },
    );
    api.openapi(
      createRoute({ method: "delete", path: "/{taskId}", summary: "Dequeue task", description: "Takes a queued task out of the queue, so no agent is started on it.", security, request: { params: z.object({ taskId: z.string() }) }, responses: { 200: json(z.object({ removed: z.literal(true) }), "Removed."), 400: json(ErrorSchema, "The task is not queued.") } }),
      async (c) => {
        if (!(await q.dequeue(c.req.valid("param").taskId))) throw new Invalid("that task is not queued");
        return c.json({ removed: true as const }, 200);
      },
    );
    api.openapi(
      createRoute({ method: "put", path: "/limit", summary: "Set limit", description: `How many queued tasks run at once, 0 to ${MAX_LIMIT}; 0 pauses the queue. Default 2.`, security, request: { body: { content: { "application/json": { schema: LimitInput } }, required: true } }, responses: { 200: json(StateSchema, "The queue."), ...errors } }),
      async (c) => {
        q.setLimit(c.req.valid("json").limit);
        await q.tick();
        return c.json(state(q), 200);
      },
    );
    api.openapi(
      createRoute({ method: "post", path: "/tick", summary: "Look now", description: "Looks at the queue at once instead of waiting for the next look.", security, responses: { 200: json(StateSchema, "The queue.") } }),
      async (c) => {
        await q.tick();
        return c.json(state(q), 200);
      },
    );
  };
}

export function tools(q: QueueService): Tool[] {
  return [
    tool({ name: "list_queue", title: "List queue", description: "Returns the limit and every entry: queued ones first in order, then started, finished and dropped, each with its state and why it waits.", readOnly: true, input: {}, run: () => state(q) }),
    tool({
      name: "queue_task",
      title: "Queue task",
      description: "Queues a task at the back, or before another queued one; queuing it again moves it. An agent is started on it once it is ready and there is room under the limit.",
      input: QueueInput.shape,
      run: async ({ taskId, ...options }, caller) => q.queue(taskId, caller, options),
    }),
    tool({
      name: "dequeue_task",
      title: "Dequeue task",
      description: "Takes a queued task out of the queue, so no agent is started on it.",
      input: { taskId: z.string().min(1).describe("The task's id or short id.") },
      run: async ({ taskId }) => {
        if (!(await q.dequeue(taskId))) throw new Invalid("that task is not queued");
        return { removed: true };
      },
    }),
    tool({
      name: "set_limit",
      title: "Set limit",
      description: `Sets how many queued tasks run at once, 0 to ${MAX_LIMIT}; 0 pauses the queue. A higher limit starts more agents at once and so spends more tokens.`,
      input: LimitInput.shape,
      run: async ({ limit }) => {
        q.setLimit(limit);
        await q.tick();
        return { limit: q.limit };
      },
    }),
    tool({ name: "tick", title: "Look now", description: "Looks at the queue at once, starting what is ready and has room, and returns the queue.", input: {}, run: async () => (await q.tick(), state(q)) }),
  ];
}
