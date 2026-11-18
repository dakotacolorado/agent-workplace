import { z } from "@hono/zod-openapi";
import { MAX_CRITERIA, MAX_LABELS, MAX_SUBTASKS, STATUSES, VERIFIERS, VERIFY_WHEN } from "./domain.ts";

export const Status = z.enum(STATUSES).describe("Where it stands. `done` and `cancelled` are the closed statuses.");

export const TaskRef = z.string().min(8).describe("The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.");
export const LabelRef = z.string().min(1).describe("The label's ID or name.");
export const ClientToken = z.string().min(1).max(64).optional().describe("A unique string you choose; retrying with it returns what the first request created.");

export const Paging = {
  maxResults: z.coerce.number().int().min(1).max(500).optional().describe("The most results to return. Default 100."),
  nextToken: z.string().optional().describe("The `nextToken` from the previous page."),
};

const MAX_METADATA_BYTES = 8 * 1024;
const Metadata = z
  .record(z.string(), z.unknown())
  .refine((m) => Object.keys(m).every((k) => k.length >= 1 && k.length <= 100), { message: "keys must be 1 to 100 characters" })
  .refine((m) => Buffer.byteLength(JSON.stringify(m)) <= MAX_METADATA_BYTES, { message: "can be at most 8 KiB as JSON" })
  .describe("Loose key/value data, stored and returned as is; an update replaces it whole.");

const Criterion = z.object({
  id: z.string().optional().describe("An existing criterion's ID (`c1`); leave out for a new one."),
  text: z.string().min(1).optional().describe("What must be true. Needed for a new criterion."),
  met: z.boolean().optional().describe("Whether it has been seen to hold."),
});
const Subtask = z.object({
  id: z.string().optional().describe("An existing subtask's ID (`s1`); leave out for a new one."),
  title: z.string().min(1).optional().describe("A short name for the step. Needed for a new subtask."),
  description: z.string().optional(),
  status: Status.optional(),
  dependsOn: z.array(z.string()).optional().describe("IDs of sibling subtasks this one depends on."),
});

/** Every field a task's create or update may give. */
export const TaskFields = z.object({
  title: z.string().min(1).max(500).optional().describe("A short name for the task."),
  description: z.string().max(100_000).optional().describe("What the task is, in Markdown."),
  status: Status.optional(),
  dependsOn: z.array(TaskRef).max(100).optional().describe("The tasks that must close before this one can start, by ID or shortId. Replaces the list."),
  subtasks: z.array(Subtask).max(MAX_SUBTASKS).optional().describe("The whole list, matched by id: an entry left out is removed."),
  criteria: z.array(Criterion).max(MAX_CRITERIA).optional().describe("The whole list, matched by id: an entry left out is removed."),
  labels: z.array(LabelRef).max(MAX_LABELS).optional().describe("Labels, by ID or name. Replaces the list."),
  assignee: z.string().max(200).nullable().optional().describe("Who works on it: an agent's name or `person`; null for no one."),
  manager: z.string().max(200).nullable().optional().describe("Who manages its plan; null for no one."),
  verification: z.object({ by: z.enum(VERIFIERS), when: z.enum(VERIFY_WHEN) }).strict().nullable().optional().describe("Who checks the work, and when."),
  metadata: Metadata.optional(),
});

export const CreateTaskInput = TaskFields.required({ title: true }).extend({ clientToken: ClientToken });

export const ListTasksQuery = z.object({
  status: Status.optional().describe("Only tasks with this status."),
  ready: z.enum(["true", "false"]).optional().describe("`true` for only tasks that can be started now."),
  label: z.string().optional().describe("Only tasks with this label, by ID or name."),
  assignee: z.string().optional().describe("Only tasks assigned to this; `none` for unassigned."),
  manager: z.string().optional().describe("Only tasks managed by this; `none` for unmanaged."),
  dependsOn: z.string().optional().describe("Only tasks that depend on this task."),
  q: z.string().optional().describe("Only tasks whose title or description contains this text, ignoring case."),
  includeCancelled: z.enum(["true", "false"]).optional().describe("`true` to include cancelled tasks."),
  ...Paging,
});

export const LabelFields = z.object({
  name: z.string().trim().min(1).max(100).describe("The label's name; unique ignoring case."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("A `#rrggbb` colour. Default grey."),
  description: z.string().max(1000).optional(),
});
export const CreateLabelInput = LabelFields.extend({ clientToken: ClientToken });
export const CommentFields = z.object({ body: z.string().min(1).max(20_000).describe("The comment, in Markdown."), clientToken: ClientToken });

/** Output shapes are loose: the task view is documented by its fields above. */
export const AnyJson = z.any();
