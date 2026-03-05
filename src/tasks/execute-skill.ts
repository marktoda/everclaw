import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import type { TaskDeps } from "./shared.ts";
import { BACKGROUND_MAX_HISTORY, buildAgentDeps } from "./shared.ts";

export function registerExecuteSkill(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "execute-skill", defaultMaxAttempts: 3 },
    async (params: { skillName: string; recipientId?: string }, ctx: TaskContext) => {
      // Resolve recipientId: use explicit param (from spawn_skill) or fall back
      // to the first allowed chat ID (for scheduled skills).
      const recipientId =
        params.recipientId || [...deps.config.allowedChatIds][0] || null;

      if (!recipientId) {
        deps.log?.warn(
          { skill: params.skillName },
          "skipping scheduled skill — no allowed chat IDs configured",
        );
        return { skillName: params.skillName, skipped: true };
      }

      const agentDeps = buildAgentDeps(deps, absurd, ctx, recipientId, {
        maxHistory: BACKGROUND_MAX_HISTORY,
        taskName: "execute-skill",
      });

      agentDeps.log?.info({ skill: params.skillName }, "skill execution started");

      const skillContent = await ctx.step("read-skill", async () => {
        const abs = path.resolve(deps.config.dirs.skills, `${params.skillName}.md`);
        if (!abs.startsWith(deps.config.dirs.skills + path.sep)) {
          throw new Error(`Invalid skill name: ${params.skillName}`);
        }
        return await fs.readFile(abs, "utf-8");
      });

      const reply = await runAgentLoop(
        ctx,
        recipientId,
        `Execute the following skill instructions:\n\n${skillContent}`,
        agentDeps,
      );

      agentDeps.log?.info({ skill: params.skillName }, "skill execution complete");
      return { skillName: params.skillName, reply };
    },
  );
}
