import type { Absurd, TaskContext } from "absurd-sdk";
import type { ChannelRegistry } from "../channels/index.ts";

export function registerSendMessage(absurd: Absurd, channels: ChannelRegistry): void {
  absurd.registerTask(
    { name: "send-message" },
    async (params: { recipientId: string; text: string }, _ctx: TaskContext) => {
      await channels.sendMessage(params.recipientId, params.text);
      return { sent: true };
    },
  );
}
