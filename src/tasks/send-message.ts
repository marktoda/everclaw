import type { Absurd, TaskContext } from "absurd-sdk";
import type { Bot } from "grammy";

export function registerSendMessage(absurd: Absurd, bot: Bot): void {
  absurd.registerTask(
    { name: "send-message" },
    async (params: { chatId: number; text: string }, _ctx: TaskContext) => {
      await bot.api.sendMessage(params.chatId, params.text);
      return { sent: true };
    },
  );
}
