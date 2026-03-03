// src/bot.ts
import { Bot } from "grammy";
import type { Absurd } from "absurd-sdk";

export interface BotOptions {
  onFirstMessage?: (chatId: number) => Promise<void>;
}

export function createBot(token: string, absurd: Absurd, opts?: BotOptions): Bot {
  const bot = new Bot(token);
  let firstMessageCallback = opts?.onFirstMessage;

  bot.on("message:text", async (ctx) => {
    if (firstMessageCallback) {
      const cb = firstMessageCallback;
      firstMessageCallback = undefined;
      await cb(ctx.chat.id);
    }
    await absurd.spawn("handle-message", {
      chatId: ctx.chat.id,
      text: ctx.message.text,
    });
  });

  return bot;
}
