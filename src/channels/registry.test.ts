import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChannelMessage } from "./adapter.ts";
import { ChannelRegistry } from "./registry.ts";

function fakeAdapter(name: string): ChannelAdapter {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ChannelRegistry", () => {
  it("resolves adapter by chatId prefix", () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    registry.register(tg);
    expect(registry.resolve("telegram:123")).toBe(tg);
  });

  it("throws for unknown prefix", () => {
    const registry = new ChannelRegistry();
    expect(() => registry.resolve("whatsapp:123")).toThrow(
      'No channel adapter for prefix "whatsapp"',
    );
  });

  it("routes sendMessage to the correct adapter", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    const slack = fakeAdapter("slack");
    registry.register(tg);
    registry.register(slack);

    await registry.sendMessage("slack:C04", "hello");

    expect(slack.sendMessage).toHaveBeenCalledWith("slack:C04", "hello");
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("startAll starts all adapters with the same onMessage callback", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    const slack = fakeAdapter("slack");
    registry.register(tg);
    registry.register(slack);

    const onMessage = vi.fn();
    await registry.startAll(onMessage);

    expect(tg.start).toHaveBeenCalledWith(onMessage);
    expect(slack.start).toHaveBeenCalledWith(onMessage);
  });

  it("stopAll stops all adapters", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    registry.register(tg);

    await registry.stopAll();

    expect(tg.stop).toHaveBeenCalledOnce();
  });

  it("setTyping calls adapter.setTyping when present", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    tg.setTyping = vi.fn().mockResolvedValue(undefined);
    registry.register(tg);

    await registry.setTyping("telegram:123", true);

    expect(tg.setTyping).toHaveBeenCalledWith("telegram:123", true);
  });

  it("setTyping is a no-op when adapter has no setTyping", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    registry.register(tg);

    // Should not throw
    await registry.setTyping("telegram:123", true);
  });

  describe("queryMessages", () => {
    it("queryableChannels returns only adapters that implement queryMessages", () => {
      const registry = new ChannelRegistry();
      const tg = fakeAdapter("telegram");
      const gmail = fakeAdapter("gmail");
      const msgs: ChannelMessage[] = [
        { id: "1", from: "alice", text: "hi", timestamp: new Date() },
      ];
      gmail.queryMessages = vi.fn().mockResolvedValue(msgs);
      registry.register(tg);
      registry.register(gmail);

      expect(registry.queryableChannels()).toEqual(["gmail"]);
    });

    it("queryMessages routes to the correct adapter", async () => {
      const registry = new ChannelRegistry();
      const gmail = fakeAdapter("gmail");
      const msgs: ChannelMessage[] = [
        { id: "1", from: "alice", text: "hello", timestamp: new Date() },
      ];
      gmail.queryMessages = vi.fn().mockResolvedValue(msgs);
      registry.register(gmail);

      const result = await registry.queryMessages("gmail", { limit: 5 });

      expect(gmail.queryMessages).toHaveBeenCalledWith({ limit: 5 });
      expect(result).toEqual(msgs);
    });

    it("queryMessages throws for unknown channel", async () => {
      const registry = new ChannelRegistry();

      await expect(registry.queryMessages("unknown")).rejects.toThrow(
        'No channel adapter: "unknown"',
      );
    });

    it("queryMessages throws for channel that doesn't support it", async () => {
      const registry = new ChannelRegistry();
      const tg = fakeAdapter("telegram");
      registry.register(tg);

      await expect(registry.queryMessages("telegram")).rejects.toThrow(
        'Channel "telegram" does not support message queries',
      );
    });
  });
});
