import type { Absurd, TaskContext } from "absurd-sdk";
import type { ChannelRegistry } from "../channels/index.ts";

export function registerSendMessage(absurd: Absurd, channels: ChannelRegistry): void {
  absurd.registerTask(
    { name: "send-message" },
    async (params: { chatId: string; text: string }, _ctx: TaskContext) => {
      await channels.sendMessage(params.chatId, params.text);
      return { sent: true };
    },
  );
}
