import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getState, setState } from "../../memory/state.ts";
import { listScripts } from "../../scripts/runner.ts";
import { listSkills } from "../../skills/manager.ts";
import type { ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

export const stateTools: ToolHandler[] = [
  {
    def: defineTool(
      "get_state",
      "Read a value from the state store.",
      {
        namespace: { type: "string", description: "Namespace (e.g. 'workflow', 'skill:name')" },
        key: { type: "string", description: "Key" },
      },
      ["namespace", "key"],
    ),
    async execute(input, deps) {
      const { namespace, key } = input as { namespace: string; key: string };
      const val = await getState(deps.pool, namespace, key);
      return val === null ? "(not set)" : JSON.stringify(val);
    },
  },
  {
    def: defineTool(
      "set_state",
      "Write a value to the state store.",
      {
        namespace: { type: "string", description: "Namespace" },
        key: { type: "string", description: "Key" },
        value: { description: "JSON value to store" },
      },
      ["namespace", "key", "value"],
    ),
    async execute(input, deps) {
      const { namespace, key, value } = input as { namespace: string; key: string; value: unknown };
      await setState(deps.pool, namespace, key, value);
      return "State saved.";
    },
  },
  {
    def: defineTool("get_status", "Get assistant uptime, file counts, and schedule count.", {}),
    async execute(_input, deps) {
      const uptime = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
      const skills = await listSkills(deps.dirs.skills);
      const scripts = await listScripts(deps.dirs.scripts);
      const schedules = await deps.absurd.listSchedules();
      return [
        `Uptime: ${uptime}s`,
        `Pinned notes: ${(await fs.readdir(path.join(deps.dirs.notes, "pinned")).catch(() => [])).filter((e: string) => e.endsWith(".md")).length} files`,
        `Available notes: ${(await fs.readdir(deps.dirs.notes).catch(() => [])).filter((e: string) => e.endsWith(".md")).length} files`,
        `Skills: ${skills.length}`,
        `Scripts: ${scripts.length}`,
        `Schedules: ${schedules.length}`,
      ].join("\n");
    },
  },
];
