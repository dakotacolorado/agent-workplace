import { pages as agents } from "../agents/ui/agents.ts";
import { pages as roles } from "../roles/ui/roles.ts";
import { pages as skills } from "../skills/ui/skills.ts";
import { pages as tasks } from "../tasks/ui/tasks.ts";
import type { Page } from "./page.ts";

/** Every page, in nav order: Work, Workers, Skills. */
export const pages: Page[] = [...tasks, ...agents, ...skills, ...roles];
