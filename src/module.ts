import type { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { Caller, Services } from "./contracts.ts";

/** What every request carries once signed in. */
export type Env = { Variables: { caller: Caller } };

/** Per-agent tokens: the agents module issues one per agent; the auth middleware reads them. */
export interface Tokens {
  /** A new token for the agent (any earlier ones still work until revoked). */
  issue(agentId: string): string;
  /** Revokes every token of the agent. */
  revoke(agentId: string): void;
}

/** What a module is given when the app starts. */
export interface Context {
  /** The data folder (`AGENT_WORKPLACE_DIR`). */
  dir: string;
  /** `<dir>/agents`, where the agents module keeps each agent's folder. */
  agentsDir: string;
  /** The one database, `<dir>/workplace.db`, with every module's migrations applied. */
  db: DatabaseSync;
  tokens: Tokens;
  /** The other modules' interfaces. Filled once every module is created: read them at call time. */
  services: Services;
}

/** One MCP tool. Its input is a zod shape; what `run` returns is sent back as JSON text. */
export interface Tool<S extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case, e.g. `list_tasks`. */
  name: string;
  /** Two or three words, e.g. "List tasks". */
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  run(args: z.infer<z.ZodObject<S>>, caller: Caller): unknown;
}

/** Types a tool's `run` from its input shape. */
export const tool = <S extends z.ZodRawShape>(t: Tool<S>): Tool => t as unknown as Tool;

/** A running module: what its `create` returns. */
export interface Instance {
  /** Its interface in `contracts.ts`, for a module named in `Services`. */
  service?: Services[keyof Services];
  /** Adds its routes to `api`, which is mounted at `/api/<module>/` behind the auth middleware. */
  routes?(api: OpenAPIHono<Env>): void;
  tools?: Tool[];
  close?(): void | Promise<void>;
}

export interface Module {
  /** Its folder under `src/`, its routes' prefix under `/api/`, and its key in `Services` if it has one. */
  name: string;
  /** SQL scripts, applied in order, each once. Append new ones; never edit an applied one. */
  migrations: string[];
  create(ctx: Context): Instance;
}

/** Thrown by a skeleton module's interface for what its task has yet to build. */
export class NotBuilt extends Error {
  constructor(what: string) {
    super(`${what} is not built yet`);
  }
}
