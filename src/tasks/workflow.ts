import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import { buildAgentDeps } from "./shared.ts";
import type { TaskDeps } from "./shared.ts";

export function registerWorkflow(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "workflow" },
    async (params: { recipientId: string; instructions: string; context?: unknown }, ctx: TaskContext) => {
      const contextPrefix = params.context
        ? `Context: ${JSON.stringify(params.context)}\n\n`
        : "";

      const agentDeps = buildAgentDeps(deps, absurd, ctx, params.recipientId, {
        maxHistory: 10,
        taskName: "workflow",
      });

      agentDeps.log?.info("workflow started");

      const reply = await runAgentLoop(
        ctx, params.recipientId,
        `${contextPrefix}${params.instructions}`,
        agentDeps,
      );

      agentDeps.log?.info("workflow complete");
      return { reply };
    },
  );
}
