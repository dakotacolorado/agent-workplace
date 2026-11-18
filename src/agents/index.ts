import type { Module } from "../module.ts";
import { routes, tools } from "./api.ts";
import * as claude from "./claude.ts";
import { MIGRATIONS } from "./migrations.ts";
import { startSdkSession, type StartSession } from "./runner.ts";
import { AgentService, DEFAULT_MAX_AGENTS } from "./service.ts";

export interface AgentsModuleOptions {
  /** How a session runs; tests give a fake. Default: Claude Code through the Agent SDK. */
  startSession?: StartSession;
  /** Default `AGENT_WORKPLACE_MAX_AGENTS`, or 3. */
  maxAgents?: number;
  /** The app's own address, for each session's MCP config. Default `AGENT_WORKPLACE_URL`, or `http://127.0.0.1:<AGENT_WORKPLACE_PORT or 4747>`. */
  url?: string;
  /** The environment sessions start from. Default the app's own. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  resumeAfterMs?: number;
  lookEveryMs?: number;
}

/** The agents module: Claude Code sessions, each in its own folder under `agents/`, admitted up to a limit. */
export function agentsModule(options: AgentsModuleOptions = {}): Module {
  return {
    name: "agents",
    migrations: MIGRATIONS,
    create(ctx) {
      const env = options.env ?? process.env;
      const max = options.maxAgents ?? (Number(env.AGENT_WORKPLACE_MAX_AGENTS) || DEFAULT_MAX_AGENTS);
      const url = (options.url ?? env.AGENT_WORKPLACE_URL ?? `http://127.0.0.1:${Number(env.AGENT_WORKPLACE_PORT || 4747)}`).replace(/\/+$/, "");
      const svc = new AgentService(ctx, {
        startSession: options.startSession ?? startSdkSession,
        maxAgents: Math.max(1, Math.floor(max)),
        url,
        env: claude.baseEnv(env),
        login: claude.loginDir(env.CLAUDE_CONFIG_DIR, ctx.agentsDir),
        ...(options.now ? { now: options.now } : {}),
        ...(options.resumeAfterMs !== undefined ? { resumeAfterMs: options.resumeAfterMs } : {}),
        ...(options.lookEveryMs !== undefined ? { lookEveryMs: options.lookEveryMs } : {}),
      });
      return { service: svc, routes: routes(svc), tools: tools(svc), close: () => svc.shutdown() };
    },
  };
}

export const agents: Module = agentsModule();
