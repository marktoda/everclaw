import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";
import type { TaskDeps } from "./handle-message.ts";


export function registerWorkflow(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "workflow" },
    async (params: { chatId: number; instructions: string; context?: any }, ctx: TaskContext) => {
      const log = deps.log?.child({ task: "workflow", chatId: params.chatId });
      log?.info("workflow started");

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

      const contextPrefix = params.context
        ? `Context: ${JSON.stringify(params.context)}\n\n`
        : "";

      const reply = await runAgentLoop(
        ctx,
        params.chatId,
        `${contextPrefix}${params.instructions}`,
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

      log?.info("workflow complete");
      return { reply };
    },
  );
}
