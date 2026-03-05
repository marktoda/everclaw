import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { TextChannel } from "discord.js";
import { logger } from "../logger.ts";
import { stripPrefix, type ChannelAdapter, type InboundMessage } from "./adapter.ts";
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
        recipientId: `discord:${message.channel.id}`,
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

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const channelId = stripPrefix(recipientId);
    const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
    if (!channel) throw new Error(`Discord channel not found: ${channelId}`);

    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await channel.send(chunk);
    }
  }

  isConnected(): boolean {
    return this.client.isReady();
  }

  async setTyping(recipientId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const channelId = stripPrefix(recipientId);
    const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
    if (channel) await channel.sendTyping();
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    logger.info("Discord adapter stopped");
  }
}
