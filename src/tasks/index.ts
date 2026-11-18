import type { Task as ContractTask, TaskComment, Tasks } from "../contracts.ts";
import type { Module } from "../module.ts";
import { taskRoutes } from "./routes.ts";
import { TaskOps } from "./service.ts";
import { MIGRATIONS } from "./store.ts";
import { taskTools } from "./tools.ts";

/** The work: tasks with criteria, subtasks, dependencies, labels, comments and history. */
export const tasks: Module = {
  name: "tasks",
  migrations: MIGRATIONS,
  create(ctx) {
    const ops = new TaskOps(ctx);
    const find = (id: string) => {
      try {
        return ops.getTask(id);
      } catch {
        return undefined;
      }
    };
    const service: Tasks = {
      get: async (id) => find(id) as ContractTask | undefined,
      listReady: async () => ops.list({ ready: true }) as ContractTask[],
      update: async (id, change, by) => ops.update(id, change, await ops.actor(by)) as ContractTask,
      comment: async (id, body, by) => ops.comment(id, body, await ops.actor(by)) as TaskComment,
      onEvent: (listener) => ops.onEvent(listener),
    };
    return { service, routes: (api) => taskRoutes(api, ops), tools: taskTools(ops) };
  },
};
