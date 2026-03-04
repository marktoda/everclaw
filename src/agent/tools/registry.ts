import { fileTools } from "./files.ts";
import { orchestrationTools } from "./orchestration.ts";
import { scriptTools } from "./scripts.ts";
import { searchTools } from "./search.ts";
import { stateTools } from "./state.ts";
import type { ExecutorDeps, ToolDef, ToolHandler } from "./types.ts";

export interface ToolRegistry {
  definitions: ToolDef[];
  execute(name: string, input: Record<string, any>): Promise<string>;
  isSuspending(name: string): boolean;
}

export interface McpToolSource {
  definitions(): ToolDef[];
  execute(toolName: string, input: Record<string, unknown>): Promise<string>;
}

const allHandlers: ToolHandler[] = [
  ...fileTools,
  ...stateTools,
  ...scriptTools,
  ...orchestrationTools,
  ...searchTools,
];

const handlerMap = new Map(allHandlers.map((h) => [h.def.name, h]));
const builtinDefinitions: ToolDef[] = allHandlers.map((h) => h.def);

export function createToolRegistry(deps: ExecutorDeps, mcp?: McpToolSource): ToolRegistry {
  return {
    definitions: [...builtinDefinitions, ...(mcp?.definitions() ?? [])],
    async execute(name: string, input: Record<string, any>): Promise<string> {
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
