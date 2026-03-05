import { Bot } from "grammy";
import { logger } from "../logger.ts";
import { transcribeAudio } from "../transcription.ts";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";
import { markdownToTelegramHtml } from "./format-telegram.ts";
import { splitMessage } from "./split.ts";

export interface TelegramAdapterOptions {
  openaiApiKey?: string;
}

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram" as const;
  private maxMessageLength = 4096;
  private bot: Bot;
  private openaiApiKey?: string;

  constructor(token: string, options?: TelegramAdapterOptions) {
    this.bot = new Bot(token);
    this.openaiApiKey = options?.openaiApiKey;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.bot.on("message:text", async (ctx) => {
      await onMessage({
        recipientId: `telegram:${ctx.chat.id}`,
        text: ctx.message.text,
      });
    });

    if (this.openaiApiKey) {
      const apiKey = this.openaiApiKey;
      this.bot.on("message:voice", async (ctx) => {
        const recipientId = `telegram:${ctx.chat.id}`;
        let text = "[Voice Message - transcription unavailable]";
        try {
          const file = await ctx.api.getFile(ctx.message.voice.file_id);
          if (!file.file_path) throw new Error("Telegram returned no file_path for voice message");
          const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`File download failed: ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const transcript = await transcribeAudio(buf, apiKey);
          text = `[Voice: ${transcript}]`;
        } catch (err) {
          logger.warn({ err, recipientId }, "voice transcription failed");
        }
        await onMessage({ recipientId, text });
      });
    }

    this.bot.start({ onStart: () => {} }).catch((err) => {
      logger.fatal({ err }, "Telegram bot polling crashed");
      process.exit(1);
    });
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const chatId = Number(recipientId.slice(this.name.length + 1));
    const html = markdownToTelegramHtml(text);
    for (const chunk of splitMessage(html, this.maxMessageLength)) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
      } catch (err: any) {
        if (err?.error_code === 400) {
          logger.warn({ err, chatId }, "HTML parse failed, falling back to plain text");
          await this.bot.api.sendMessage(chatId, chunk);
        } else {
          throw err;
        }
      }
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
