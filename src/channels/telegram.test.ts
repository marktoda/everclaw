import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock transcription module
vi.mock("../transcription.ts", () => ({
  transcribeAudio: vi.fn().mockResolvedValue("hello from voice"),
}));

import { transcribeAudio } from "../transcription.ts";

// Mock fetch
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
});
vi.stubGlobal("fetch", mockFetch);

// Mock grammy
type Handler = (ctx: any) => Promise<void>;
const capturedHandlers = new Map<string, Handler>();
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();

vi.mock("grammy", () => {
  class Bot {
    token: string;
    api = { sendMessage: mockSendMessage };
    constructor(token: string) {
      this.token = token;
    }
    on(filter: string, handler: Handler) {
      capturedHandlers.set(filter, handler);
    }
    start(_opts?: any) { return Promise.resolve(); }
    stop() {
      mockStop();
      return Promise.resolve();
    }
  }
  return { Bot };
});

import { TelegramAdapter } from "./telegram.ts";

function makeGrammyCtx(chatId: number, text: string) {
  return { chat: { id: chatId }, message: { text } };
}

function makeVoiceCtx(chatId: number, fileId: string) {
  return {
    chat: { id: chatId },
    message: { voice: { file_id: fileId } },
    api: { getFile: vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" }) },
  };
}

describe("TelegramAdapter", () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockSendMessage.mockClear();
    mockStop.mockClear();
    mockFetch.mockClear();
    vi.mocked(transcribeAudio).mockClear();
    vi.mocked(transcribeAudio).mockResolvedValue("hello from voice");
  });

  it("has name 'telegram'", () => {
    const adapter = new TelegramAdapter("token");
    expect(adapter.name).toBe("telegram");
  });

  it("start registers a message handler and calls onMessage with prefixed recipientId", async () => {
    const adapter = new TelegramAdapter("token");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    const handler = capturedHandlers.get("message:text");
    expect(handler).toBeDefined();

    await handler?.(makeGrammyCtx(123456789, "hello"));

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({
      recipientId: "telegram:123456789",
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

  describe("voice messages", () => {
    it("transcribes voice and delivers as [Voice: ...]", async () => {
      const adapter = new TelegramAdapter("token", { openaiApiKey: "sk-key" });
      const onMessage = vi.fn().mockResolvedValue(undefined);

      await adapter.start(onMessage);
      const handler = capturedHandlers.get("message:voice");
      expect(handler).toBeDefined();

      await handler?.(makeVoiceCtx(42, "abc123"));

      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage).toHaveBeenCalledWith({
        recipientId: "telegram:42",
        text: "[Voice: hello from voice]",
      });
      expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), "sk-key");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottoken/voice/file_0.oga",
      );
    });

    it("delivers fallback when transcription fails", async () => {
      vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error("API error"));

      const adapter = new TelegramAdapter("token", { openaiApiKey: "sk-key" });
      const onMessage = vi.fn().mockResolvedValue(undefined);

      await adapter.start(onMessage);
      const handler = capturedHandlers.get("message:voice");
      expect(handler).toBeDefined();

      await handler?.(makeVoiceCtx(42, "abc123"));

      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage).toHaveBeenCalledWith({
        recipientId: "telegram:42",
        text: "[Voice Message - transcription unavailable]",
      });
    });

    it("does not register voice handler when no openaiApiKey", async () => {
      const adapter = new TelegramAdapter("token");
      const onMessage = vi.fn().mockResolvedValue(undefined);

      await adapter.start(onMessage);
      expect(capturedHandlers.has("message:voice")).toBe(false);
    });
  });
});
