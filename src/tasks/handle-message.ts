import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import { buildAgentDeps, type TaskDeps } from "./shared.ts";

export type { TaskDeps } from "./shared.ts";

export function registerHandleMessage(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "handle-message", defaultMaxAttempts: 3 },
    async (params: { recipientId: string; text: string }, ctx: TaskContext) => {
      const agentDeps = buildAgentDeps(deps, absurd, ctx, params.recipientId, {
        taskName: "handle-message",
      });

      agentDeps.log?.info({ textLength: params.text.length }, "message received");

      const reply = await runAgentLoop(ctx, params.recipientId, params.text, agentDeps);

      agentDeps.log?.info({ replyLength: reply.length }, "message complete");
      return { reply };
    },
  );
}
