import type { Tasks } from "../contracts.ts";
import { NotBuilt, type Module } from "../module.ts";

/** The work: tasks with criteria, dependencies and comments. A skeleton: it holds no tasks yet. */
export const tasks: Module = {
  name: "tasks",
  migrations: [],
  create() {
    const service: Tasks = {
      get: async () => undefined,
      listReady: async () => [],
      update: async () => {
        throw new NotBuilt("tasks.update");
      },
      comment: async () => {
        throw new NotBuilt("tasks.comment");
      },
    };
    return { service };
  },
};
