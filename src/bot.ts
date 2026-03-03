// src/bot.ts
import { Bot } from "grammy";
import type { Absurd } from "absurd-sdk";

export interface BotOptions {
  onFirstMessage?: (chatId: number) => Promise<void>;
}

export function createBot(token: string, absurd: Absurd, opts?: BotOptions): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    if (opts?.onFirstMessage) {
      await opts.onFirstMessage(ctx.chat.id);
      opts.onFirstMessage = undefined; // Only fire once
    }
    await absurd.spawn("handle-message", {
      chatId: ctx.chat.id,
      text: ctx.message.text,
    });
  });

  return bot;
}
