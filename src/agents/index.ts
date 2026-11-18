import type { Agents } from "../contracts.ts";
import { NotBuilt, type Module } from "../module.ts";

/** The agents: Claude sessions, each in its own folder under `agents/`. A skeleton: it starts none yet. */
export const agents: Module = {
  name: "agents",
  migrations: [],
  create() {
    const service: Agents = {
      create: async () => {
        throw new NotBuilt("agents.create");
      },
      get: async () => undefined,
      list: async () => [],
      send: async () => {
        throw new NotBuilt("agents.send");
      },
      stop: async () => {
        throw new NotBuilt("agents.stop");
      },
      onEvent: () => () => {},
    };
    return { service };
  },
};
