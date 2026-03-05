import type { ChannelAdapter, InboundMessage } from "./adapter.ts";
import { logger } from "../logger.ts";

export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  resolve(recipientId: string): ChannelAdapter {
    const prefix = recipientId.split(":")[0];
    const adapter = this.adapters.get(prefix);
    if (!adapter) throw new Error(`No channel adapter for prefix "${prefix}"`);
    return adapter;
  }

  async setTyping(recipientId: string, isTyping: boolean): Promise<void> {
    const adapter = this.resolve(recipientId);
    await adapter.setTyping?.(recipientId, isTyping);
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const adapter = this.resolve(recipientId);
    await adapter.sendMessage(recipientId, text);
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
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((a) => a.stop()),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        logger.error({ err: r.reason }, "failed to stop channel adapter");
      }
    }
  }
}
