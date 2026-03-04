import type { ChannelAdapter } from "./adapter.ts";
import { TelegramAdapter } from "./telegram.ts";

const ADAPTER_FACTORIES: Record<string, (token: string) => ChannelAdapter> = {
  telegram: (token) => new TelegramAdapter(token),
};

export function createAdapter(type: string, token: string): ChannelAdapter {
  const factory = ADAPTER_FACTORIES[type];
  if (!factory) throw new Error(`Unknown channel type: "${type}"`);
  return factory(token);
}
