import type { ChannelAdapter, InboundMessage } from "./adapter.ts";

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

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const adapter = this.resolve(recipientId);
    await adapter.sendMessage(recipientId, text);
  }

  async startAll(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start(onMessage);
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }
}
