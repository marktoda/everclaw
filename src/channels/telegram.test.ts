import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./adapter.ts";

// Mock grammy
type Handler = (ctx: any) => Promise<void>;
let capturedHandler: Handler | undefined;
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();

vi.mock("grammy", () => {
  class Bot {
    token: string;
    api = { sendMessage: mockSendMessage };
    constructor(token: string) { this.token = token; }
    on(_filter: string, handler: Handler) { capturedHandler = handler; }
    start(_opts?: any) {}
    stop() { mockStop(); }
  }
  return { Bot };
});

import { TelegramAdapter } from "./telegram.ts";

function makeGrammyCtx(chatId: number, text: string) {
  return { chat: { id: chatId }, message: { text } };
}

describe("TelegramAdapter", () => {
  beforeEach(() => {
    capturedHandler = undefined;
    mockSendMessage.mockClear();
    mockStop.mockClear();
  });

  it("has name 'telegram' and maxMessageLength 4096", () => {
    const adapter = new TelegramAdapter("token");
    expect(adapter.name).toBe("telegram");
    expect(adapter.maxMessageLength).toBe(4096);
  });

  it("start registers a message handler and calls onMessage with prefixed recipientId", async () => {
    const adapter = new TelegramAdapter("token");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    expect(capturedHandler).toBeDefined();

    await capturedHandler!(makeGrammyCtx(601870898, "hello"));

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({
      recipientId: "telegram:601870898",
      text: "hello",
    });
  });

  it("sendMessage parses recipientId and calls bot.api.sendMessage", async () => {
    const adapter = new TelegramAdapter("token");
    await adapter.sendMessage("telegram:42", "hi");

    expect(mockSendMessage).toHaveBeenCalledWith(42, "hi");
  });

  it("sendMessage splits long messages", async () => {
    const adapter = new TelegramAdapter("token");
    const longText = "a".repeat(5000);

    await adapter.sendMessage("telegram:1", longText);

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[0][1]).toHaveLength(4096);
    expect(mockSendMessage.mock.calls[1][1]).toHaveLength(904);
  });

  it("stop calls bot.stop()", async () => {
    const adapter = new TelegramAdapter("token");
    await adapter.stop();
    expect(mockStop).toHaveBeenCalledOnce();
  });
});
