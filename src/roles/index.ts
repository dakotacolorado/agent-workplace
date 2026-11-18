import type { Roles } from "../contracts.ts";
import type { Module } from "../module.ts";

/** The roles agents work in: which skills, model and brief each starts with. A skeleton: it has no roles yet. */
export const roles: Module = {
  name: "roles",
  migrations: [],
  create() {
    const service: Roles = {
      list: async () => [],
      get: async () => undefined,
    };
    return { service };
  },
};
