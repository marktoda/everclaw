import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.ts";
import { buildAgentDeps, type TaskDeps } from "./shared.ts";

export type { TaskDeps } from "./shared.ts";

export function registerHandleMessage(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "handle-message" },
    async (params: { chatId: number; text: string }, ctx: TaskContext) => {
      const log = deps.log?.child({ task: "handle-message", chatId: params.chatId });
      log?.info({ textLength: params.text.length }, "message received");

      const agentDeps = buildAgentDeps(deps, absurd, ctx, params.chatId);
      agentDeps.log = log;

      const reply = await runAgentLoop(ctx, params.chatId, params.text, agentDeps);

      log?.info({ replyLength: reply.length }, "message complete");
      return { reply };
    },
  );
}
