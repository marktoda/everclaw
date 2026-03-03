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

const allHandlers: ToolHandler[] = [
  ...fileTools,
  ...stateTools,
  ...scriptTools,
  ...orchestrationTools,
  ...searchTools,
];

const handlerMap = new Map(allHandlers.map((h) => [h.def.name, h]));
const definitions: ToolDef[] = allHandlers.map((h) => h.def);

export function createToolRegistry(deps: ExecutorDeps): ToolRegistry {
  return {
    definitions,
    async execute(name: string, input: Record<string, any>): Promise<string> {
      const handler = handlerMap.get(name);
      if (!handler) return `Unknown tool: ${name}`;
      return handler.execute(input, deps);
    },
    isSuspending(name: string): boolean {
      return handlerMap.get(name)?.suspends ?? false;
    },
  };
}
