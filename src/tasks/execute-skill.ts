import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import { BACKGROUND_MAX_HISTORY } from "./shared.ts";
import type { TaskDeps } from "./shared.ts";
import { buildAgentDeps } from "./shared.ts";

export function registerExecuteSkill(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "execute-skill" },
    async (params: { skillName: string; recipientId: string }, ctx: TaskContext) => {
      const agentDeps = buildAgentDeps(deps, absurd, ctx, params.recipientId, {
        maxHistory: BACKGROUND_MAX_HISTORY,
        taskName: "execute-skill",
      });

      agentDeps.log?.info({ skill: params.skillName }, "skill execution started");

      const skillContent = await ctx.step("read-skill", async () => {
        const abs = path.resolve(deps.config.skillsDir, `${params.skillName}.md`);
        if (!abs.startsWith(deps.config.skillsDir + path.sep)) {
          throw new Error(`Invalid skill name: ${params.skillName}`);
        }
        return await fs.readFile(abs, "utf-8");
      });

      const reply = await runAgentLoop(
        ctx,
        params.recipientId,
        `Execute the following skill instructions:\n\n${skillContent}`,
        agentDeps,
      );

      agentDeps.log?.info({ skill: params.skillName }, "skill execution complete");
      return { skillName: params.skillName, reply };
    },
  );
}
