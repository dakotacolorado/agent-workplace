import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context as HonoContext } from "hono";
import type { Env } from "../module.ts";
import { ConflictError, NotFoundError, ValidationError } from "./domain.ts";
import { AnyJson, CommentFields, CreateLabelInput, CreateTaskInput, LabelFields, LabelRef, ListTasksQuery, Paging, TaskFields, TaskRef } from "./schema.ts";
import { page, type TaskOps } from "./service.ts";

const ok = (description: string) => ({ description, content: { "application/json": { schema: AnyJson } } });
const secured = { security: [{ bearer: [] }] };
const errs = { 400: ok("The request is wrong; `error` says how."), 404: ok("No such task or label."), 409: ok("The tasks as they stand refuse it; `error` says why.") };
const taskId = z.object({ taskId: TaskRef });

export function taskRoutes(api: OpenAPIHono<Env>, ops: TaskOps): void {
  api.onError((err, c) => {
    const body = { error: err.message, ...(err instanceof ConflictError ? err.details : {}) };
    if (err instanceof ValidationError) return c.json(body, 400);
    if (err instanceof NotFoundError) return c.json(body, 404);
    if (err instanceof ConflictError) return c.json(body, 409);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });
  const actor = (c: HonoContext<Env>) => ops.actor(c.get("caller"));
  const paged = <T>(key: string, items: T[], q: { maxResults?: number; nextToken?: string }) => {
    const p = page(items, q.maxResults, q.nextToken);
    return { [key]: p.items, nextToken: p.nextToken };
  };

  api.openapi(
    createRoute({ method: "get", path: "/", summary: "List tasks", description: "Tasks matching every filter given, oldest first. Cancelled tasks are left out unless `status` is `cancelled` or `includeCancelled` is `true`. Each task carries `blockedBy` (its open dependencies) and `ready` (backlog, unassigned, nothing blocking).", ...secured, request: { query: ListTasksQuery }, responses: { 200: ok("A page of tasks."), ...errs } }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(paged("tasks", ops.list(q), q), 200);
    },
  );
  api.openapi(
    createRoute({ method: "post", path: "/", summary: "Create task", description: "Makes a task in `backlog` unless `status` says otherwise. A repeated `clientToken` returns the first task.", ...secured, request: { body: { content: { "application/json": { schema: CreateTaskInput } }, required: true } }, responses: { 201: ok("The task."), ...errs } }),
    async (c) => c.json({ task: ops.create(c.req.valid("json"), await actor(c)) }, 201),
  );
  api.openapi(
    createRoute({ method: "get", path: "/labels", summary: "List labels", description: "Labels by name.", ...secured, request: { query: z.object(Paging) }, responses: { 200: ok("A page of labels."), ...errs } }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(paged("labels", ops.store.labels().all(), q), 200);
    },
  );
  api.openapi(
    createRoute({ method: "post", path: "/labels", summary: "Create label", description: "Makes a label; its name is unique ignoring case.", ...secured, request: { body: { content: { "application/json": { schema: CreateLabelInput } }, required: true } }, responses: { 201: ok("The label."), ...errs } }),
    (c) => {
      const { clientToken, ...fields } = c.req.valid("json");
      return c.json({ label: ops.store.createLabel(fields, clientToken) }, 201);
    },
  );
  api.openapi(
    createRoute({ method: "get", path: "/labels/{labelId}", summary: "Get label", ...secured, request: { params: z.object({ labelId: LabelRef }) }, responses: { 200: ok("The label."), ...errs } }),
    (c) => c.json({ label: ops.label(c.req.valid("param").labelId) }, 200),
  );
  api.openapi(
    createRoute({ method: "patch", path: "/labels/{labelId}", summary: "Update label", description: "Changes the fields given.", ...secured, request: { params: z.object({ labelId: LabelRef }), body: { content: { "application/json": { schema: LabelFields.partial() } }, required: true } }, responses: { 200: ok("The label."), ...errs } }),
    (c) => c.json({ label: ops.store.updateLabel(c.req.valid("param").labelId, c.req.valid("json")) }, 200),
  );
  api.openapi(
    createRoute({ method: "get", path: "/{taskId}", summary: "Get task", ...secured, request: { params: taskId }, responses: { 200: ok("The task."), ...errs } }),
    (c) => c.json({ task: ops.getTask(c.req.valid("param").taskId) }, 200),
  );
  api.openapi(
    createRoute({ method: "patch", path: "/{taskId}", summary: "Update task", description: "Changes the fields given. `criteria` and `subtasks` are whole lists matched by `id`: an entry left out is removed, a field left out of an entry keeps its value. A task leaves `backlog` only once every dependency is closed, and reaches `done` only once every criterion is met and every subtask closed. Cancelling cancels its open subtasks. `metadata` is replaced whole.", ...secured, request: { params: taskId, body: { content: { "application/json": { schema: TaskFields } }, required: true } }, responses: { 200: ok("The task."), ...errs } }),
    async (c) => c.json({ task: ops.update(c.req.valid("param").taskId, c.req.valid("json"), await actor(c)) }, 200),
  );
  api.openapi(
    createRoute({ method: "get", path: "/{taskId}/history", summary: "Task history", description: "Every change to the task, oldest first.", ...secured, request: { params: taskId, query: z.object(Paging) }, responses: { 200: ok("A page of changes."), ...errs } }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(paged("entries", ops.store.taskHistory(c.req.valid("param").taskId), q), 200);
    },
  );
  api.openapi(
    createRoute({ method: "get", path: "/{taskId}/comments", summary: "List comments", description: "The task's comments, oldest first.", ...secured, request: { params: taskId, query: z.object(Paging) }, responses: { 200: ok("A page of comments."), ...errs } }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(paged("comments", ops.store.comments(c.req.valid("param").taskId), q), 200);
    },
  );
  api.openapi(
    createRoute({ method: "post", path: "/{taskId}/comments", summary: "Create comment", description: "Adds a comment by the caller: `person`, or the agent's name. It changes none of the task's fields.", ...secured, request: { params: taskId, body: { content: { "application/json": { schema: CommentFields } }, required: true } }, responses: { 201: ok("The comment."), ...errs } }),
    async (c) => {
      const { body, clientToken } = c.req.valid("json");
      return c.json({ comment: ops.comment(c.req.valid("param").taskId, body, await actor(c), clientToken) }, 201);
    },
  );
}
