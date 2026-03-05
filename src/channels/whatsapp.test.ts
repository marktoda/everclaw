import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendMessage = vi
  .fn()
  .mockImplementation(() => Promise.resolve({ key: { id: `msg-${Date.now()}` } }));
const mockSendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
const mockEnd = vi.fn();
let capturedHandlers: Record<string, Function> = {};
let mockSockInstance: any;

vi.mock("@whiskeysockets/baileys", () => {
  return {
    default: vi.fn().mockImplementation(() => {
      capturedHandlers = {};
      mockSockInstance = {
        ev: {
          on(event: string, handler: Function) {
            capturedHandlers[event] = handler;
          },
          removeAllListeners: vi.fn(),
        },
        sendMessage: mockSendMessage,
        sendPresenceUpdate: mockSendPresenceUpdate,
        end: mockEnd,
      };
      return mockSockInstance;
    }),
    useMultiFileAuthState: vi.fn().mockResolvedValue({
      state: {},
      saveCreds: vi.fn(),
    }),
    DisconnectReason: { loggedOut: 401, connectionClosed: 408 },
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  };
});

import { WhatsAppAdapter } from "./whatsapp.ts";

describe("WhatsAppAdapter", () => {
  beforeEach(() => {
    capturedHandlers = {};
    mockSendMessage.mockClear();
    mockSendPresenceUpdate.mockClear();
    mockEnd.mockClear();
  });

  it("has name 'whatsapp'", () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter.name).toBe("whatsapp");
  });

  it("start connects and registers message handler", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);

    expect(capturedHandlers["messages.upsert"]).toBeDefined();
    expect(capturedHandlers["creds.update"]).toBeDefined();
    expect(capturedHandlers["connection.update"]).toBeDefined();
  });

  it("handles inbound text message", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);

    await capturedHandlers["messages.upsert"]?.({
      messages: [
        {
          key: { remoteJid: "5551234567@s.whatsapp.net", fromMe: false },
          message: { conversation: "hello" },
        },
      ],
      type: "notify",
    });

    expect(onMessage).toHaveBeenCalledWith({
      recipientId: "whatsapp:5551234567",
      text: "hello",
    });
  });

  it("handles extendedTextMessage", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);

    await capturedHandlers["messages.upsert"]?.({
      messages: [
        {
          key: { remoteJid: "5551234567@s.whatsapp.net", fromMe: false },
          message: { extendedTextMessage: { text: "extended hello" } },
        },
      ],
      type: "notify",
    });

    expect(onMessage).toHaveBeenCalledWith({
      recipientId: "whatsapp:5551234567",
      text: "extended hello",
    });
  });

  it("allows self-chat messages (fromMe) through", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);

    await capturedHandlers["messages.upsert"]?.({
      messages: [
        {
          key: { id: "user-msg-1", remoteJid: "5551234567@s.whatsapp.net", fromMe: true },
          message: { conversation: "hello" },
        },
      ],
      type: "notify",
    });

    expect(onMessage).toHaveBeenCalledWith({
      recipientId: "whatsapp:5551234567",
      text: "hello",
    });
  });

  it("skips echo of own outgoing messages", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);

    // Bot sends a message — ID gets tracked
    mockSendMessage.mockResolvedValueOnce({ key: { id: "bot-reply-1" } });
    await adapter.sendMessage("whatsapp:5551234567", "bot reply");

    // Echo arrives back via upsert with the same ID
    await capturedHandlers["messages.upsert"]?.({
      messages: [
        {
          key: { id: "bot-reply-1", remoteJid: "5551234567@s.whatsapp.net", fromMe: true },
          message: { conversation: "bot reply" },
        },
      ],
      type: "notify",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores group messages", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);

    await capturedHandlers["messages.upsert"]?.({
      messages: [
        {
          key: { remoteJid: "123456789@g.us", fromMe: false },
          message: { conversation: "group msg" },
        },
      ],
      type: "notify",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("sendMessage sends to correct JID", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    await adapter.sendMessage("whatsapp:5551234567", "hello");

    expect(mockSendMessage).toHaveBeenCalledWith("5551234567@s.whatsapp.net", { text: "hello" });
  });

  it("setTyping sends composing presence", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    await adapter.setTyping("whatsapp:5551234567", true);

    expect(mockSendPresenceUpdate).toHaveBeenCalledWith("composing", "5551234567@s.whatsapp.net");
  });

  it("setTyping sends paused presence when false", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    await adapter.setTyping("whatsapp:5551234567", false);

    expect(mockSendPresenceUpdate).toHaveBeenCalledWith("paused", "5551234567@s.whatsapp.net");
  });

  it("stop ends connection", async () => {
    const adapter = new WhatsAppAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);
    await adapter.stop();

    expect(mockEnd).toHaveBeenCalled();
  });
});
