import { agents } from "./agents/index.ts";
import type { Module } from "./module.ts";
import { queue } from "./queue/index.ts";
import { roles } from "./roles/index.ts";
import { skills } from "./skills/index.ts";
import { tasks } from "./tasks/index.ts";

/** Every module of the app, created in this order. Add one here when you add its folder. */
export const modules: Module[] = [tasks, skills, roles, agents, queue];
