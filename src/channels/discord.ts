import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { TextChannel } from "discord.js";
import { logger } from "../logger.ts";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";
import { splitMessage } from "./split.ts";

export class DiscordAdapter implements ChannelAdapter {
  name = "discord" as const;
  private maxMessageLength = 2000;
  private client: Client;
  private token: string;

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

      // Strip bot mentions
      let text = message.content;
      if (this.client.user) {
        text = text.replace(new RegExp(`<@!?${this.client.user.id}>\\s*`, "g"), "").trim();
      }
      if (!text) return;

      await onMessage({
        recipientId: `discord:${message.channel.id}`,
        text,
      });
    });

    await this.client.login(this.token);
    logger.info("Discord adapter started");
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const channelId = recipientId.slice(this.name.length + 1);
    const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
    if (!channel) throw new Error(`Discord channel not found: ${channelId}`);

    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await channel.send(chunk);
    }
  }

  async setTyping(recipientId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const channelId = recipientId.slice(this.name.length + 1);
    const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
    if (channel) await channel.sendTyping();
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    logger.info("Discord adapter stopped");
  }
}
