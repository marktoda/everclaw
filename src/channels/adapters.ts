import type { ChannelAdapter } from "./adapter.ts";
import { TelegramAdapter } from "./telegram.ts";

export interface AdapterOptions {
  openaiApiKey?: string;
}

const ADAPTER_FACTORIES: Record<string, (token: string, opts: AdapterOptions) => ChannelAdapter> = {
  telegram: (token, opts) => new TelegramAdapter(token, { openaiApiKey: opts.openaiApiKey }),
};

export function createAdapter(type: string, token: string, opts: AdapterOptions = {}): ChannelAdapter {
  const factory = ADAPTER_FACTORIES[type];
  if (!factory) throw new Error(`Unknown channel type: "${type}"`);
  return factory(token, opts);
}
