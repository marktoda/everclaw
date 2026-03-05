import { describe, expect, it, vi } from "vitest";

vi.mock("@slack/bolt", () => {
  class App {
    client = { chat: { postMessage: vi.fn() } };
    event() {}
    start = vi.fn();
    stop = vi.fn();
  }
  return { App };
});

vi.mock("@whiskeysockets/baileys", () => {
  return {
    default: vi.fn().mockReturnValue({
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      sendMessage: vi.fn(),
      sendPresenceUpdate: vi.fn(),
      end: vi.fn(),
    }),
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  };
});

vi.mock("discord.js", () => {
  const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 };
  const Partials = { Channel: 0 };
  class Client {
    user = { id: "bot" };
    channels = { fetch: vi.fn() };
    on() { return this; }
    login = vi.fn();
    destroy = vi.fn();
  }
  return { Client, GatewayIntentBits, Partials };
});

import { createAdapter } from "./adapters.ts";

describe("createAdapter", () => {
  it("creates a TelegramAdapter for type 'telegram'", () => {
    const adapter = createAdapter("telegram", "fake-token");
    expect(adapter.name).toBe("telegram");
  });

  it("creates a DiscordAdapter for type 'discord'", () => {
    const adapter = createAdapter("discord", "fake-token");
    expect(adapter.name).toBe("discord");
  });

  it("creates a SlackAdapter for type 'slack'", () => {
    const adapter = createAdapter("slack", "xoxb-fake|xapp-fake");
    expect(adapter.name).toBe("slack");
  });

  it("creates a WhatsAppAdapter for type 'whatsapp'", () => {
    const adapter = createAdapter("whatsapp", "enabled");
    expect(adapter.name).toBe("whatsapp");
  });

  it("throws for unknown channel type", () => {
    expect(() => createAdapter("carrier-pigeon", "token")).toThrow("Unknown channel type");
  });
});
