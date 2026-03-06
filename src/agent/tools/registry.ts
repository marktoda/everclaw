import type Anthropic from "@anthropic-ai/sdk";
import { browserTools } from "./browser.ts";
import { channelTools } from "./channels.ts";
import { fileTools } from "./files.ts";
import { orchestrationTools } from "./orchestration.ts";
import { scriptTools } from "./scripts.ts";
import { searchTools } from "./search.ts";
import { statusTools } from "./status.ts";
import type { ExecutorDeps, ToolHandler } from "./types.ts";

export interface ToolRegistry {
  definitions: Anthropic.Tool[];
  execute(name: string, input: Record<string, unknown>): Promise<string>;
  isSuspending(name: string): boolean;
}

export interface McpToolSource {
  definitions(): Anthropic.Tool[];
  execute(toolName: string, input: Record<string, unknown>): Promise<string>;
}

const allHandlers: ToolHandler[] = [
  ...fileTools,
  ...statusTools,
  ...scriptTools,
  ...orchestrationTools,
  ...searchTools,
  ...channelTools,
  ...browserTools,
];

const handlerMap = new Map(allHandlers.map((h) => [h.def.name, h]));
const builtinDefinitions: Anthropic.Tool[] = allHandlers.map((h) => h.def);

export function createToolRegistry(deps: ExecutorDeps, mcp?: McpToolSource): ToolRegistry {
  return {
    definitions: [...builtinDefinitions, ...(mcp?.definitions() ?? [])],
    async execute(name: string, input: Record<string, unknown>): Promise<string> {
      const handler = handlerMap.get(name);
      if (handler) return handler.execute(input, deps);
      if (mcp) return mcp.execute(name, input);
      return `Unknown tool: ${name}`;
    },
    isSuspending(name: string): boolean {
      return handlerMap.get(name)?.suspends ?? false;
    },
  };
}
