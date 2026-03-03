import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.js";
import { getTools } from "../agent/tools.js";
import { createExecutor } from "../agent/executor.js";
import type { TaskDeps } from "./handle-message.js";
import * as fs from "fs/promises";
import * as path from "path";

export function registerExecuteSkill(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "execute-skill" },
    async (params: { skillName: string; chatId: number }, ctx: TaskContext) => {
      const skillContent = await ctx.step("read-skill", async () => {
        return await fs.readFile(
          path.join(deps.config.skillsDir, `${params.skillName}.md`),
          "utf-8",
        );
      });

      const executeTool = createExecutor({
        absurd,
        pool: deps.pool,
        ctx,
        queueName: deps.config.queueName,
        chatId: params.chatId,
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        scriptTimeout: deps.config.scriptTimeout,
        startedAt: deps.startedAt,
      });

      const reply = await runAgentLoop(
        ctx,
        params.chatId,
        `Execute the following skill instructions:\n\n${skillContent}`,
        {
          anthropic: deps.anthropic,
          pool: deps.pool,
          model: deps.config.model,
          notesDir: deps.config.notesDir,
          skillsDir: deps.config.skillsDir,
          toolsDir: deps.config.toolsDir,
          maxHistory: 10,
          tools: getTools(),
          executeTool,
          onText: (text) => {
            deps.bot.api.sendMessage(params.chatId, text).catch(() => {});
          },
        },
      );

      return { skillName: params.skillName, reply };
    },
  );
}
