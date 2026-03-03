import * as fs from "fs/promises";
import { getState, setState } from "../../memory/state.ts";
import { listSkills } from "../../skills/manager.ts";
import { listTools } from "../../scripts/runner.ts";
import { defineTool } from "./types.ts";
import type { ToolHandler } from "./types.ts";

export const stateTools: ToolHandler[] = [
  {
    def: defineTool("get_state", "Read a value from the state store.", {
      namespace: { type: "string", description: "Namespace (e.g. 'workflow', 'skill:name')" },
      key: { type: "string", description: "Key" },
    }, ["namespace", "key"]),
    async execute(input, deps) {
      const val = await getState(deps.pool, input.namespace, input.key);
      return val === null ? "(not set)" : JSON.stringify(val);
    },
  },
  {
    def: defineTool("set_state", "Write a value to the state store.", {
      namespace: { type: "string", description: "Namespace" },
      key: { type: "string", description: "Key" },
      value: { description: "JSON value to store" },
    }, ["namespace", "key", "value"]),
    async execute(input, deps) {
      await setState(deps.pool, input.namespace, input.key, input.value);
      return "State saved.";
    },
  },
  {
    def: defineTool("get_status", "Get assistant uptime, file counts, and schedule count.", {}),
    async execute(_input, deps) {
      const uptime = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
      const skills = await listSkills(deps.skillsDir);
      const tools = await listTools(deps.toolsDir);
      const schedules = await deps.absurd.listSchedules();
      return [
        `Uptime: ${uptime}s`,
        `Notes: ${(await fs.readdir(deps.notesDir).catch(() => [])).length} files`,
        `Skills: ${skills.length}`,
        `Tools: ${tools.length}`,
        `Schedules: ${schedules.length}`,
      ].join("\n");
    },
  },
];
