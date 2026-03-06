import { Bot } from "grammy";
import { logger } from "../logger.ts";
import { transcribeAudio } from "../transcription.ts";
import { type ChannelAdapter, type InboundMessage, stripPrefix } from "./adapter.ts";
import { markdownToEntities, splitWithEntities } from "./format-telegram.ts";

interface TelegramAdapterOptions {
  openaiApiKey?: string;
}

const MAX_MESSAGE_LENGTH = 4096;

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram" as const;
  private bot: Bot;
  private openaiApiKey?: string;
  private connected = false;

  constructor(token: string, options?: TelegramAdapterOptions) {
    this.bot = new Bot(token);
    this.openaiApiKey = options?.openaiApiKey;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.bot.on("message:text", async (ctx) => {
      await onMessage({
        chatId: `telegram:${ctx.chat.id}`,
        text: ctx.message.text,
      });
    });

    if (this.openaiApiKey) {
      const apiKey = this.openaiApiKey;
      this.bot.on("message:voice", async (ctx) => {
        const chatId = `telegram:${ctx.chat.id}`;
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
          logger.warn({ err, chatId }, "voice transcription failed");
        }
        await onMessage({ chatId, text });
      });
    }

    this.connected = true;
    this.bot.start({ onStart: () => {} }).catch((err) => {
      this.connected = false;
      logger.error({ err }, "Telegram bot polling crashed");
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const tgChatId = Number(stripPrefix(chatId));
    const formatted = markdownToEntities(text);
    for (const chunk of splitWithEntities(formatted, MAX_MESSAGE_LENGTH)) {
      await this.bot.api.sendMessage(tgChatId, chunk.text, {
        entities: chunk.entities.length > 0 ? chunk.entities : undefined,
      });
    }
  }

  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const tgChatId = Number(stripPrefix(chatId));
    await this.bot.api.sendChatAction(tgChatId, "typing");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async stop(): Promise<void> {
    this.connected = false;
    await this.bot.stop();
  }
}
