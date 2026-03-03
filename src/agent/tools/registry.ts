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

export function createToolRegistry(deps: ExecutorDeps): ToolRegistry {
  const map = new Map<string, ToolHandler>();
  for (const handler of allHandlers) {
    map.set(handler.def.name, handler);
  }

  return {
    definitions: allHandlers.map((h) => h.def),
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
