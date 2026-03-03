import type { Absurd, TaskContext } from "absurd-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { Bot } from "grammy";
import { runAgentLoop } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";

export interface TaskDeps {
  anthropic: Anthropic;
  pool: Pool;
  bot: Bot;
  config: Config;
  startedAt: Date;
  log?: Logger;
}

export function registerHandleMessage(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "handle-message" },
    async (params: { chatId: number; text: string }, ctx: TaskContext) => {
      const log = deps.log?.child({ task: "handle-message", chatId: params.chatId });
      log?.info({ textLength: params.text.length }, "message received");

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

      const reply = await runAgentLoop(ctx, params.chatId, params.text, {
        anthropic: deps.anthropic,
        pool: deps.pool,
        model: deps.config.model,
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        maxHistory: deps.config.maxHistoryMessages,
        tools: registry.definitions,
        executeTool: registry.execute,
        isSuspending: registry.isSuspending,
        log,
        onText: (text) => {
          deps.bot.api.sendMessage(params.chatId, text).catch(() => {});
        },
      });

      log?.info({ replyLength: reply.length }, "message complete");
      return { reply };
    },
  );
}
