import type { TextChannel } from "discord.js";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { logger } from "../logger.ts";
import {
  type ChannelAdapter,
  type ChannelMessage,
  type InboundMessage,
  type QueryOptions,
  stripPrefix,
} from "./adapter.ts";
import { splitMessage } from "./split.ts";

export class DiscordAdapter implements ChannelAdapter {
  name = "discord" as const;
  private maxMessageLength = 2000;
  private client: Client;
  private token: string;
  private mentionRegex?: RegExp;

  constructor(token: string) {
    this.token = token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.client.on("messageCreate", async (message) => {
      if (message.author.bot) return;

      // Strip bot mentions (regex compiled once after login)
      let text = message.content;
      if (this.mentionRegex) {
        text = text.replace(this.mentionRegex, "").trim();
      }
      if (!text) return;

      await onMessage({
        chatId: `discord:${message.channel.id}`,
        text,
      });
    });

    this.client.on("error", (err) => {
      logger.error({ err }, "Discord client error");
    });

    await this.client.login(this.token);
    if (this.client.user) {
      this.mentionRegex = new RegExp(`<@!?${this.client.user.id}>\\s*`, "g");
    }
    logger.info("Discord adapter started");
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const channelId = stripPrefix(chatId);
    const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
    if (!channel) throw new Error(`Discord channel not found: ${channelId}`);

    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await channel.send(chunk);
    }
  }

  isConnected(): boolean {
    return this.client.isReady();
  }

  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const channelId = stripPrefix(chatId);
    const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
    if (channel) await channel.sendTyping();
  }

  async queryMessages(opts?: QueryOptions): Promise<ChannelMessage[]> {
    if (!this.client.isReady()) throw new Error("Discord not connected");

    const limit = Math.min(opts?.limit ?? 10, 50);
    const results: ChannelMessage[] = [];

    // Collect text channels the bot is in across all guilds + cached DMs
    const channels: TextChannel[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      for (const ch of guild.channels.cache.values()) {
        if (ch.isTextBased() && !ch.isThread()) channels.push(ch as TextChannel);
      }
    }
    for (const ch of this.client.channels.cache.values()) {
      if (ch.isDMBased() && ch.isTextBased()) channels.push(ch as unknown as TextChannel);
    }

    // Fetch recent messages from each channel, collect up to limit
    for (const ch of channels) {
      if (results.length >= limit) break;
      try {
        const messages = await ch.messages.fetch({
          limit: Math.min(limit - results.length, 100),
          cache: false,
        });
        for (const msg of messages.values()) {
          if (msg.author.bot) continue;
          const text = msg.content;
          if (!text) continue;
          if (opts?.query && !text.toLowerCase().includes(opts.query.toLowerCase())) continue;
          results.push({
            id: msg.id,
            from: msg.author.displayName || msg.author.username,
            text,
            timestamp: msg.createdAt,
            chatId: `discord:${ch.id}`,
          });
        }
      } catch {
        // Skip channels where we lack ReadMessageHistory permission
      }
    }

    // Sort newest first, apply limit
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return results.slice(0, limit);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    logger.info("Discord adapter stopped");
  }
}
