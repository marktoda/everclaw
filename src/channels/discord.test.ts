import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock discord.js
type Handler = (...args: any[]) => void;
const capturedHandlers = new Map<string, Handler>();
const mockSend = vi.fn().mockResolvedValue(undefined);
const mockSendTyping = vi.fn().mockResolvedValue(undefined);
const mockFetch = vi.fn();
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockBotId = "bot123";

vi.mock("discord.js", () => {
  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  };
  const Partials = { Channel: 0 };
  class Client {
    user = { id: mockBotId };
    channels = { fetch: mockFetch };
    on(event: string, handler: Handler) {
      capturedHandlers.set(event, handler);
      return this;
    }
    login = mockLogin;
    destroy = mockDestroy;
  }
  return { Client, GatewayIntentBits, Partials };
});

import { DiscordAdapter } from "./discord.ts";

describe("DiscordAdapter", () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockSend.mockClear();
    mockSendTyping.mockClear();
    mockFetch.mockClear();
    mockDestroy.mockClear();
    mockLogin.mockClear();
  });

  it("has name 'discord'", () => {
    const adapter = new DiscordAdapter("token");
    expect(adapter.name).toBe("discord");
  });

  it("start registers messageCreate handler and calls onMessage with prefixed chatId", async () => {
    const adapter = new DiscordAdapter("token");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    expect(mockLogin).toHaveBeenCalledWith("token");

    const handler = capturedHandlers.get("messageCreate");
    expect(handler).toBeDefined();

    await handler?.({
      author: { id: "user456", bot: false },
      content: "hello",
      channel: { id: "ch789", send: mockSend, sendTyping: mockSendTyping },
    });

    expect(onMessage).toHaveBeenCalledWith({
      chatId: "discord:ch789",
      text: "hello",
    });
  });

  it("ignores messages from bots", async () => {
    const adapter = new DiscordAdapter("token");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    const handler = capturedHandlers.get("messageCreate");

    await handler?.({
      author: { id: "other-bot", bot: true },
      content: "hello",
      channel: { id: "ch789", send: mockSend, sendTyping: mockSendTyping },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("strips bot mentions from message text", async () => {
    const adapter = new DiscordAdapter("token");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    const handler = capturedHandlers.get("messageCreate");

    await handler?.({
      author: { id: "user456", bot: false },
      content: `<@${mockBotId}> what's the weather?`,
      channel: { id: "ch789", send: mockSend, sendTyping: mockSendTyping },
    });

    expect(onMessage).toHaveBeenCalledWith({
      chatId: "discord:ch789",
      text: "what's the weather?",
    });
  });

  it("sendMessage fetches channel and splits long messages at 2000 chars", async () => {
    const mockChannel = { send: mockSend };
    mockFetch.mockResolvedValue(mockChannel);

    const adapter = new DiscordAdapter("token");
    await adapter.sendMessage("discord:ch1", "a".repeat(3000));

    expect(mockFetch).toHaveBeenCalledWith("ch1");
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0]).toHaveLength(2000);
    expect(mockSend.mock.calls[1][0]).toHaveLength(1000);
  });

  it("setTyping fetches channel and sends typing indicator", async () => {
    const mockChannel = { sendTyping: mockSendTyping };
    mockFetch.mockResolvedValue(mockChannel);

    const adapter = new DiscordAdapter("token");
    await adapter.setTyping("discord:ch1", true);

    expect(mockFetch).toHaveBeenCalledWith("ch1");
    expect(mockSendTyping).toHaveBeenCalledOnce();
  });

  it("setTyping is a no-op when isTyping is false", async () => {
    const adapter = new DiscordAdapter("token");
    await adapter.setTyping("discord:ch1", false);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stop destroys the client", async () => {
    const adapter = new DiscordAdapter("token");
    await adapter.stop();
    expect(mockDestroy).toHaveBeenCalledOnce();
  });
});
