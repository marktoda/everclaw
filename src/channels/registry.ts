import { logger } from "../logger.ts";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";

export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  resolve(chatId: string): ChannelAdapter {
    const prefix = chatId.split(":")[0];
    const adapter = this.adapters.get(prefix);
    if (!adapter) throw new Error(`No channel adapter for prefix "${prefix}"`);
    return adapter;
  }

  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    const adapter = this.resolve(chatId);
    await adapter.setTyping?.(chatId, isTyping);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const adapter = this.resolve(chatId);
    if (!adapter.isConnected()) {
      logger.warn({ chatId, channel: adapter.name }, "adapter disconnected — send may fail");
    }
    await adapter.sendMessage(chatId, text);
  }

  async startAll(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.start(onMessage);
      } catch (err) {
        logger.error({ err, channel: adapter.name }, "failed to start channel adapter");
      }
    }
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.adapters.values()].map((a) => a.stop()));
    for (const r of results) {
      if (r.status === "rejected") {
        logger.error({ err: r.reason }, "failed to stop channel adapter");
      }
    }
  }
}
