import { Bot } from "grammy";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";
import { splitMessage } from "./split.ts";

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram" as const;
  private maxMessageLength = 4096;
  private bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.bot.on("message:text", async (ctx) => {
      await onMessage({
        recipientId: `telegram:${ctx.chat.id}`,
        text: ctx.message.text,
      });
    });
    this.bot.start({ onStart: () => {} });
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const chatId = Number(recipientId.slice(this.name.length + 1));
    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
  }

  async stop(): Promise<void> {
    this.bot.stop();
  }
}
