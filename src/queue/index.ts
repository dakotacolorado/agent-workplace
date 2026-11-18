import type { Module } from "../module.ts";

/** The queue: starts an agent on each queued task once it is ready and there is room. A skeleton: it queues nothing yet. */
export const queue: Module = {
  name: "queue",
  migrations: [],
  create() {
    return {};
  },
};
