import type { ChannelAdapter } from "./adapter.ts";
import { DiscordAdapter } from "./discord.ts";
import { SlackAdapter } from "./slack.ts";
import { TelegramAdapter } from "./telegram.ts";
import { WhatsAppAdapter } from "./whatsapp.ts";

export interface AdapterOptions {
  openaiApiKey?: string;
}

const ADAPTER_FACTORIES: Record<string, (token: string, opts: AdapterOptions) => ChannelAdapter> = {
  discord: (token) => new DiscordAdapter(token),
  slack: (token) => new SlackAdapter(token),
  telegram: (token, opts) => new TelegramAdapter(token, { openaiApiKey: opts.openaiApiKey }),
  whatsapp: () => new WhatsAppAdapter(),
};

export function createAdapter(
  type: string,
  token: string,
  opts: AdapterOptions = {},
): ChannelAdapter {
  const factory = ADAPTER_FACTORIES[type];
  if (!factory) throw new Error(`Unknown channel type: "${type}"`);
  return factory(token, opts);
}
