import type { ToolHandler, ExecutorDeps, ToolDef } from "./types.ts";
import { fileTools } from "./files.ts";
import { stateTools } from "./state.ts";
import { scriptTools } from "./scripts.ts";
import { orchestrationTools } from "./orchestration.ts";
import { searchTools } from "./search.ts";

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

export function createToolRegistry(deps: ExecutorDeps): ToolRegistry {
  const map = new Map<string, ToolHandler>();
  for (const handler of allHandlers) {
    map.set(handler.def.name, handler);
  }

  return {
    definitions: allHandlers.map(h => h.def),
    async execute(name: string, input: Record<string, any>): Promise<string> {
      const handler = map.get(name);
      if (!handler) return `Unknown tool: ${name}`;
      return handler.execute(input, deps);
    },
    isSuspending(name: string): boolean {
      const handler = map.get(name);
      return handler?.suspends ?? false;
    },
  };
}
