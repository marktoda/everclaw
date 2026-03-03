import { runScript, listTools } from "../../scripts/runner.ts";
import { defineTool } from "./types.ts";
import type { ToolHandler } from "./types.ts";

export const scriptTools: ToolHandler[] = [
  {
    def: defineTool("run_script", "Execute a tool script. Input is passed as JSON stdin.", {
      name: { type: "string", description: "Tool script name (without extension)" },
      input: { type: "object", description: "JSON input to pass to the script" },
    }, ["name"]),
    async execute(input, deps) {
      const { name, input: scriptInput } = input as { name: string; input?: unknown };
      const tools = await listTools(deps.toolsDir);
      const tool = tools.find(t => t.name === name);
      if (!tool) return `Tool "${name}" not found. Available: ${tools.map(t => t.name).join(", ")}`;
      return await runScript(tool.path, JSON.stringify(scriptInput ?? {}), deps.scriptTimeout, deps.scriptEnv);
    },
  },
];
