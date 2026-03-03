import type { Absurd, TaskContext } from "absurd-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { Bot } from "grammy";
import { runAgentLoop } from "../agent/loop.js";
import { getTools } from "../agent/tools.js";
import { createExecutor } from "../agent/executor.js";
import type { Config } from "../config.js";

export interface TaskDeps {
  anthropic: Anthropic;
  pool: Pool;
  bot: Bot;
  config: Config;
  startedAt: Date;
}

export function registerHandleMessage(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "handle-message" },
    async (params: { chatId: number; text: string }, ctx: TaskContext) => {
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

      const reply = await runAgentLoop(ctx, params.chatId, params.text, {
        anthropic: deps.anthropic,
        pool: deps.pool,
        model: deps.config.model,
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        maxHistory: deps.config.maxHistoryMessages,
        tools: getTools(),
        executeTool,
        onText: (text) => {
          deps.bot.api.sendMessage(params.chatId, text).catch(() => {});
        },
      });

      return { reply };
    },
  );
}
