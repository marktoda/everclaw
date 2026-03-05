import { App } from "@slack/bolt";
import { logger } from "../logger.ts";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";
import { splitMessage } from "./split.ts";

export class SlackAdapter implements ChannelAdapter {
  name = "slack" as const;
  private maxMessageLength = 4000;
  private app: App;

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

    await this.app.start();
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const channel = recipientId.slice(this.name.length + 1);
    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await this.app.client.chat.postMessage({ channel, text: chunk });
    }
  }

  // Slack Bot API does not support typing indicators
  async setTyping(_recipientId: string, _isTyping: boolean): Promise<void> {}

  async stop(): Promise<void> {
    await this.app.stop();
  }
}
