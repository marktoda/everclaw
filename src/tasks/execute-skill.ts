import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import { buildAgentDeps } from "./shared.ts";
import type { TaskDeps } from "./shared.ts";
import * as fs from "fs/promises";
import * as path from "path";

export function registerExecuteSkill(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "execute-skill" },
    async (params: { skillName: string; chatId: number }, ctx: TaskContext) => {
      const log = deps.log?.child({ task: "execute-skill", chatId: params.chatId, skill: params.skillName });
      log?.info("skill execution started");

      const skillContent = await ctx.step("read-skill", async () => {
        const abs = path.resolve(deps.config.skillsDir, `${params.skillName}.md`);
        if (!abs.startsWith(deps.config.skillsDir + path.sep)) {
          throw new Error(`Invalid skill name: ${params.skillName}`);
        }
        return await fs.readFile(abs, "utf-8");
      });

      const agentDeps = buildAgentDeps(deps, absurd, ctx, params.chatId, { maxHistory: 10 });
      agentDeps.log = log;

      const reply = await runAgentLoop(
        ctx, params.chatId,
        `Execute the following skill instructions:\n\n${skillContent}`,
        agentDeps,
      );

      log?.info("skill execution complete");
      return { skillName: params.skillName, reply };
    },
  );
}
