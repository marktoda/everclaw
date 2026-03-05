import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listScripts } from "../../scripts/runner.ts";
import { listSkills } from "../../skills/manager.ts";
import type { ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

export const statusTools: ToolHandler[] = [
  {
    def: defineTool("get_status", "Get assistant uptime, file counts, and schedule count.", {}),
    async execute(_input, deps) {
      const uptime = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
      const [skills, scripts, schedules, pinnedEntries, noteEntries] = await Promise.all([
        listSkills(deps.dirs.skills),
        listScripts(deps.dirs.scripts),
        deps.absurd.listSchedules(),
        fs.readdir(path.join(deps.dirs.notes, "pinned")).catch(() => [] as string[]),
        fs.readdir(deps.dirs.notes).catch(() => [] as string[]),
      ]);
      return [
        `Uptime: ${uptime}s`,
        `Pinned notes: ${pinnedEntries.filter((e) => e.endsWith(".md")).length} files`,
        `Available notes: ${noteEntries.filter((e) => e.endsWith(".md")).length} files`,
        `Skills: ${skills.length}`,
        `Scripts: ${scripts.length}`,
        `Schedules: ${schedules.length}`,
      ].join("\n");
    },
  },
];
