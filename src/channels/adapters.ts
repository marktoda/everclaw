import { FLAG_CHANNELS } from "../config.ts";
import type { ChannelAdapter } from "./adapter.ts";

export interface AdapterOptions {
  openaiApiKey?: string;
  gmailLabel?: string;
}

const ADAPTER_FACTORIES: Record<
  string,
  (token: string, opts: AdapterOptions) => ChannelAdapter | Promise<ChannelAdapter>
> = {
  discord: async (token) => {
    const { DiscordAdapter } = await import("./discord.ts");
    return new DiscordAdapter(token);
  },
  slack: async (token) => {
    const { SlackAdapter } = await import("./slack.ts");
    return new SlackAdapter(token);
  },
  telegram: async (token, opts) => {
    const { TelegramAdapter } = await import("./telegram.ts");
    return new TelegramAdapter(token, { openaiApiKey: opts.openaiApiKey });
  },
  gmail: async (_token, opts) => {
    const { GmailAdapter } = await import("./gmail.ts");
    return new GmailAdapter({ label: opts.gmailLabel ?? "everclaw" });
  },
  whatsapp: async () => {
    const { WhatsAppAdapter } = await import("./whatsapp.ts");
    return new WhatsAppAdapter();
  },
};

export async function createAdapter(
  type: string,
  token?: string,
  opts: AdapterOptions = {},
): Promise<ChannelAdapter> {
  const factory = ADAPTER_FACTORIES[type];
  if (!factory) throw new Error(`Unknown channel type: "${type}"`);
  if (!token && !FLAG_CHANNELS.has(type)) {
    throw new Error(`CHANNEL_${type.toUpperCase()} requires a token`);
  }
  return factory(token ?? "", opts);
}
