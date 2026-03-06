import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import type { TaskDeps } from "./shared.ts";
import { BACKGROUND_MAX_HISTORY, buildAgentDeps } from "./shared.ts";

export function registerWorkflow(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "workflow", defaultMaxAttempts: 3 },
    async (
      params: { chatId: string; instructions: string; context?: unknown },
      ctx: TaskContext,
    ) => {
      const contextPrefix = params.context ? `Context: ${JSON.stringify(params.context)}\n\n` : "";

      const agentDeps = buildAgentDeps(deps, absurd, ctx, params.chatId, {
        maxHistory: BACKGROUND_MAX_HISTORY,
        taskName: "workflow",
      });

      agentDeps.log?.info("workflow started");

      const reply = await runAgentLoop(
        ctx,
        params.chatId,
        `${contextPrefix}${params.instructions}`,
        agentDeps,
      );

      agentDeps.log?.info("workflow complete");
      return { reply };
    },
  );
}
