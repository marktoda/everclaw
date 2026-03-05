import { App } from "@slack/bolt";
import { logger } from "../logger.ts";
import { stripPrefix, type ChannelAdapter, type InboundMessage } from "./adapter.ts";
import { splitMessage } from "./split.ts";

export class SlackAdapter implements ChannelAdapter {
  name = "slack" as const;
  private maxMessageLength = 4000;
  private app: App;
  private connected = false;

  constructor(token: string) {
    const [botToken, appToken] = token.split("|");
    if (!botToken || !appToken) {
      throw new Error("CHANNEL_SLACK must be 'bot_token|app_token' (pipe-delimited)");
    }
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
    });
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.app.event("message", async ({ event }) => {
      // Ignore bot messages and subtypes (edits, joins, etc.)
      if ("subtype" in event && event.subtype) return;
      if (!("text" in event) || !event.text || !("user" in event)) return;

      await onMessage({
        recipientId: `slack:${event.channel}`,
        text: event.text,
      });
    });

    this.app.error(async (err) => {
      logger.error({ err }, "Slack app error");
    });

    await this.app.start();
    this.connected = true;
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const channel = stripPrefix(recipientId);
    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await this.app.client.chat.postMessage({ channel, text: chunk });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async stop(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }
}
