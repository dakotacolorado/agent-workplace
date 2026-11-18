import type { Module } from "../module.ts";
import { INSTRUCTIONS, routes, tools } from "./api.ts";
import { MIGRATIONS } from "./migrations.ts";
import { LOOK_EVERY_MS, QueueService } from "./service.ts";

export interface QueueModuleOptions {
  /** How often it looks, in ms. Default 30 seconds. */
  lookEveryMs?: number;
  now?: () => Date;
}

/** The queue: starts an agent on each queued task once it is ready, while fewer than the limit run. */
export function queueModule(options: QueueModuleOptions = {}): Module {
  return {
    name: "queue",
    migrations: MIGRATIONS,
    create(ctx) {
      const svc = new QueueService(ctx, options.now ? { now: options.now } : {});
      // Other modules' services exist only once every module is created: start after that.
      const starter = setTimeout(() => svc.begin(options.lookEveryMs ?? LOOK_EVERY_MS), 0);
      starter.unref();
      return { routes: routes(svc), tools: tools(svc), instructions: INSTRUCTIONS, close: () => (clearTimeout(starter), svc.close()) };
    },
  };
}

export const queue: Module = queueModule();
