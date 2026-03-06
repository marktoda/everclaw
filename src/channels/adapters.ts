import type { ChannelAdapter } from "./adapter.ts";

export interface AdapterOptions {
  openaiApiKey?: string;
  gmailLabel?: string;
}

interface AdapterFactory {
  requiresToken: boolean;
  create: (token: string, opts: AdapterOptions) => ChannelAdapter | Promise<ChannelAdapter>;
}

const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  discord: {
    requiresToken: true,
    create: async (token) => {
      const { DiscordAdapter } = await import("./discord.ts");
      return new DiscordAdapter(token);
    },
  },
  slack: {
    requiresToken: true,
    create: async (token) => {
      const { SlackAdapter } = await import("./slack.ts");
      return new SlackAdapter(token);
    },
  },
  telegram: {
    requiresToken: true,
    create: async (token, opts) => {
      const { TelegramAdapter } = await import("./telegram.ts");
      return new TelegramAdapter(token, { openaiApiKey: opts.openaiApiKey });
    },
  },
  gmail: {
    requiresToken: false,
    create: async (_token, opts) => {
      const { GmailAdapter } = await import("./gmail.ts");
      return new GmailAdapter({ label: opts.gmailLabel ?? "everclaw" });
    },
  },
  whatsapp: {
    requiresToken: false,
    create: async () => {
      const { WhatsAppAdapter } = await import("./whatsapp.ts");
      return new WhatsAppAdapter();
    },
  },
};

export async function createAdapter(
  type: string,
  token?: string,
  opts: AdapterOptions = {},
): Promise<ChannelAdapter> {
  const factory = ADAPTER_FACTORIES[type];
  if (!factory) throw new Error(`Unknown channel type: "${type}"`);
  if (!token && factory.requiresToken) {
    throw new Error(`CHANNEL_${type.toUpperCase()} requires a token`);
  }
  return factory.create(token ?? "", opts);
}
