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

vi.mock("googleapis", () => {
  const gmail = {
    users: {
      messages: { list: vi.fn(), get: vi.fn(), send: vi.fn(), modify: vi.fn() },
      getProfile: vi.fn(),
    },
  };
  return {
    google: {
      gmail: vi.fn().mockReturnValue(gmail),
      auth: {
        OAuth2: class {
          setCredentials = vi.fn();
          generateAuthUrl = vi.fn();
          on = vi.fn();
        },
      },
    },
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockImplementation((filePath: string) => {
    if (filePath.includes("credentials.json")) {
      return Promise.resolve(
        JSON.stringify({
          installed: {
            client_id: "id",
            client_secret: "secret",
            redirect_uris: ["http://localhost"],
          },
        }),
      );
    }
    if (filePath.includes("token.json")) {
      return Promise.resolve(JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    }
    return Promise.reject(new Error("ENOENT"));
  }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("discord.js", () => {
  const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 };
  const Partials = { Channel: 0 };
  class Client {
    user = { id: "bot" };
    channels = { fetch: vi.fn() };
    on() {
      return this;
    }
    login = vi.fn();
    destroy = vi.fn();
  }
  return { Client, GatewayIntentBits, Partials };
});

import { createAdapter } from "./adapters.ts";

describe("createAdapter", () => {
  it("creates a TelegramAdapter for type 'telegram'", async () => {
    const adapter = await createAdapter("telegram", "fake-token");
    expect(adapter.name).toBe("telegram");
  });

  it("creates a DiscordAdapter for type 'discord'", async () => {
    const adapter = await createAdapter("discord", "fake-token");
    expect(adapter.name).toBe("discord");
  });

  it("creates a SlackAdapter for type 'slack'", async () => {
    const adapter = await createAdapter("slack", "xoxb-fake|xapp-fake");
    expect(adapter.name).toBe("slack");
  });

  it("creates a WhatsAppAdapter for type 'whatsapp' (no token needed)", async () => {
    const adapter = await createAdapter("whatsapp");
    expect(adapter.name).toBe("whatsapp");
  });

  it("creates a GmailAdapter for type 'gmail' (no token needed)", async () => {
    const adapter = await createAdapter("gmail");
    expect(adapter.name).toBe("gmail");
  });

  it("rejects unknown channel type", async () => {
    await expect(createAdapter("carrier-pigeon", "token")).rejects.toThrow("Unknown channel type");
  });
});
