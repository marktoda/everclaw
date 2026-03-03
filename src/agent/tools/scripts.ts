import { listScripts, runScript } from "../../scripts/runner.ts";
import type { ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

export const scriptTools: ToolHandler[] = [
  {
    def: defineTool(
      "run_script",
      "Execute a tool script. Input is passed as JSON stdin.",
      {
        name: { type: "string", description: "Tool script name (without extension)" },
        input: { type: "object", description: "JSON input to pass to the script" },
      },
      ["name"],
    ),
    async execute(input, deps) {
      const { name, input: scriptInput } = input as { name: string; input?: unknown };
      const scripts = await listScripts(deps.scriptsDir);
      const script = scripts.find((s) => s.name === name);
      if (!script)
        return `Tool "${name}" not found. Available: ${scripts.map((s) => s.name).join(", ")}`;
      try {
        return await runScript(
          script.path,
          JSON.stringify(scriptInput ?? {}),
          deps.scriptTimeout,
          deps.scriptEnv,
        );
      } catch (err) {
        return `Script error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
