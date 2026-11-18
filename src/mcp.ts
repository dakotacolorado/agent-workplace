import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Caller } from "./contracts.ts";
import type { Tool } from "./module.ts";

export const INSTRUCTIONS =
  "agent-workplace holds the work (tasks and their queue), the agents working on it in roles, and the skills they work by. Each tool says what it does; your token says who you are.";

/** One MCP server for one request, with every module's tools, each run as `caller`, and each module's instructions after the app's. */
export function mcpServer(tools: Tool[], version: string, caller: Caller, more: string[] = []): McpServer {
  const server = new McpServer({ name: "agent-workplace", version }, { instructions: [INSTRUCTIONS, ...more].join("\n\n"), capabilities: { tools: {} } });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input, annotations: { readOnlyHint: t.readOnly ?? false } },
      async (args: Record<string, unknown>) => {
        try {
          const result = await t.run(args as never, caller);
          return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
        }
      },
    );
  }
  return server;
}
