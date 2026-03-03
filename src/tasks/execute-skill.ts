import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";
import type { TaskDeps } from "./handle-message.ts";
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

      const registry = createToolRegistry({
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
        searchApiKey: deps.config.braveSearchApiKey,
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
          registry,
          log,
          onText: (text) => {
            deps.bot.api.sendMessage(params.chatId, text).catch(() => {});
          },
        },
      );

      log?.info("skill execution complete");
      return { skillName: params.skillName, reply };
    },
  );
}
