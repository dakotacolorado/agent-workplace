import { z } from "@hono/zod-openapi";
import { tool, type Tool } from "../module.ts";
import { ClientToken, CommentFields, CreateLabelInput, LabelFields, LabelRef, Paging, Status, TaskFields, TaskRef } from "./schema.ts";
import { page, type TaskOps } from "./service.ts";

const paging = { maxResults: Paging.maxResults, nextToken: Paging.nextToken };

export function taskTools(ops: TaskOps): Tool[] {
  const paged = <T>(key: string, items: T[], q: { maxResults?: number; nextToken?: string }) => {
    const p = page(items, q.maxResults, q.nextToken);
    return { [key]: p.items, nextToken: p.nextToken };
  };
  return [
    tool({
      name: "list_tasks",
      title: "List tasks",
      description: "Returns tasks matching every filter given, oldest first. Cancelled tasks are left out unless status is cancelled or includeCancelled is true. ready=true returns only unassigned backlog tasks with nothing blocking them.",
      readOnly: true,
      input: {
        status: Status.optional().describe("Only tasks with this status."),
        ready: z.boolean().optional().describe("true for only tasks that can be started now."),
        label: z.string().optional().describe("Only tasks with this label, by ID or name."),
        assignee: z.string().optional().describe("Only tasks assigned to this; none for unassigned tasks."),
        manager: z.string().optional().describe("Only tasks managed by this; none for unmanaged tasks."),
        dependsOn: z.string().optional().describe("Only tasks that depend on this task."),
        q: z.string().optional().describe("Only tasks whose title or description contains this text, ignoring case."),
        includeCancelled: z.boolean().optional().describe("true to include cancelled tasks."),
        ...paging,
      },
      run: (a) => paged("tasks", ops.list(a), a),
    }),
    tool({
      name: "create_task",
      title: "Create a task",
      description: "Creates a task in backlog, unless status says otherwise. A repeated clientToken returns the first task.",
      input: { ...TaskFields.required({ title: true }).shape, clientToken: ClientToken },
      run: async (a, caller) => ({ task: ops.create(a, await ops.actor(caller)) }),
    }),
    tool({
      name: "get_task",
      title: "Get a task",
      description: "Returns a task, with blockedBy and ready.",
      readOnly: true,
      input: { taskId: TaskRef },
      run: ({ taskId }) => ({ task: ops.getTask(taskId) }),
    }),
    tool({
      name: "update_task",
      title: "Update a task",
      description:
        "Changes the fields given. criteria and subtasks are whole lists matched by id: an entry left out is removed, a field left out of an entry keeps its value. A task leaves backlog only once its dependencies are closed, and reaches done only once every criterion is met and every subtask closed.",
      input: { taskId: TaskRef, ...TaskFields.shape },
      run: async ({ taskId, ...fields }, caller) => ({ task: ops.update(taskId, fields, await ops.actor(caller)) }),
    }),
    tool({
      name: "list_task_history",
      title: "List task history",
      description: "Returns every change to the task, oldest first.",
      readOnly: true,
      input: { taskId: TaskRef, ...paging },
      run: ({ taskId, ...q }) => paged("entries", ops.store.taskHistory(taskId), q),
    }),
    tool({
      name: "create_comment",
      title: "Create a comment",
      description: "Adds a comment to a task, by the caller. A comment changes none of the task's fields.",
      input: { taskId: TaskRef, ...CommentFields.shape },
      run: async ({ taskId, body, clientToken }, caller) => ({ comment: ops.comment(taskId, body, await ops.actor(caller), clientToken) }),
    }),
    tool({
      name: "list_comments",
      title: "List comments",
      description: "Returns a task's comments, oldest first.",
      readOnly: true,
      input: { taskId: TaskRef, ...paging },
      run: ({ taskId, ...q }) => paged("comments", ops.store.comments(taskId), q),
    }),
    tool({
      name: "create_label",
      title: "Create a label",
      description: "Creates a label to put on tasks; its name is unique ignoring case.",
      input: CreateLabelInput.shape,
      run: ({ clientToken, ...fields }) => ({ label: ops.store.createLabel(fields, clientToken) }),
    }),
    tool({
      name: "list_labels",
      title: "List labels",
      description: "Returns labels by name.",
      readOnly: true,
      input: paging,
      run: (q) => paged("labels", ops.store.labels().all(), q),
    }),
    tool({
      name: "get_label",
      title: "Get a label",
      description: "Returns a label by ID or name.",
      readOnly: true,
      input: { labelId: LabelRef },
      run: ({ labelId }) => ({ label: ops.label(labelId) }),
    }),
    tool({
      name: "update_label",
      title: "Update a label",
      description: "Changes the label's fields given.",
      input: { labelId: LabelRef, ...LabelFields.partial().shape },
      run: ({ labelId, ...patch }) => ({ label: ops.store.updateLabel(labelId, patch) }),
    }),
  ];
}
