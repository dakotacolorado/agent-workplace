import type { StarterSkill } from "../../contracts.ts";
import { PREFIX, ROLE_FILE, SKILL_FILE, bodyOf, skillMd, type RoleSettings } from "../domain.ts";
import { implementerRole, plannerRole, projectManagerRole, readmeWriting, rules, tasksToMerge } from "./text.ts";

/** The skills every role below shares, after its own. */
export const RULES = "workplace/rules";
export const TASKS_TO_MERGE = "workplace/tasks-to-merge";
export const README_WRITING = "workplace/readme-writing";

const roles: { name: string; text: string; settings: RoleSettings }[] = [
  {
    name: "planner",
    text: plannerRole,
    settings: {
      summary: "Turns what the person wants done into tasks with acceptance criteria, verification, dependencies and difficulty, and starts a project manager on them. Started by the person when there is new work to plan.",
      skills: [RULES, TASKS_TO_MERGE, README_WRITING],
      priority: 40,
      capability: 3,
      brief:
        "You are a planner. If the rest of your brief does not already say what the person wants done, ask them, in this chat: set your status `waiting` and end your turn; their answer starts you again. Then plan it as your role says, as tasks, and start their project manager. Write the tasks; do not take them or do the work.",
      whenDone: "stop",
    },
  },
  {
    name: "project-manager",
    text: projectManagerRole,
    settings: {
      summary: "Runs one plan's tasks (those it manages): queues them, briefs their implementers, decides their product questions or asks the planner, checks and closes their merged work, and ends with one report for the person. Started by a planner or the person.",
      skills: [RULES, TASKS_TO_MERGE],
      priority: 35,
      capability: 2,
      brief:
        "You are a project manager. Manage the tasks whose manager is your name (in agent.json), as your role says: queue them, keep their implementers moving, close their work and end with one report. Only if none name you and the rest of your brief names no tasks, ask the person, in this chat, which label you manage (set your status `waiting` and end your turn).",
      whenDone: "stop",
    },
  },
  {
    name: "implementer",
    text: implementerRole,
    settings: {
      summary: "Does one task: makes the change, runs the repo's own checks, merges its own PR once they pass, and closes the task once every criterion is met. Started on a task by the queue, a project manager or the person.",
      skills: [RULES, TASKS_TO_MERGE, README_WRITING],
      priority: 10,
      capability: 2,
      brief: null,
      whenDone: "stop",
    },
  },
];

const roleJson = (s: RoleSettings) => JSON.stringify(s, null, 2) + "\n";

/** The roles a fresh app starts with, each the skill `roles/<name>`, and the skills they share. */
export const DEFAULT_SKILLS: StarterSkill[] = [
  ...roles.map((r) => ({
    name: PREFIX + r.name,
    files: [
      { path: SKILL_FILE, content: skillMd(r.name, r.settings.summary, bodyOf(r.text)) },
      { path: ROLE_FILE, content: roleJson(r.settings) },
    ],
  })),
  { name: RULES, files: [{ path: SKILL_FILE, content: rules }] },
  { name: TASKS_TO_MERGE, files: [{ path: SKILL_FILE, content: tasksToMerge }] },
  { name: README_WRITING, files: [{ path: SKILL_FILE, content: readmeWriting }] },
];
