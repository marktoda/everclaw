// src/bot.ts
import { Bot } from "grammy";
import type { Absurd } from "absurd-sdk";

export function createBot(token: string, absurd: Absurd): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    await absurd.spawn("handle-message", {
      chatId: ctx.chat.id,
      text: ctx.message.text,
    });
  });

  return bot;
}
