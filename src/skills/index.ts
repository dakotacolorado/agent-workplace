import type { Skills } from "../contracts.ts";
import { NotBuilt, type Module } from "../module.ts";

/** The skills agents work by, versioned, revised from their feedback. A skeleton: it holds no skills yet. */
export const skills: Module = {
  name: "skills",
  migrations: [],
  create() {
    const service: Skills = {
      get: async () => undefined,
      list: async () => [],
      writeFile: async () => {
        throw new NotBuilt("skills.writeFile");
      },
      submitFeedback: async () => {
        throw new NotBuilt("skills.submitFeedback");
      },
    };
    return { service };
  },
};
