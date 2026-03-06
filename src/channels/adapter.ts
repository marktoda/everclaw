export interface InboundMessage {
  chatId: string;
  text: string;
}

/** Strip the channel prefix from a chatId (e.g. "telegram:123" → "123"). */
export function stripPrefix(chatId: string): string {
  return chatId.slice(chatId.indexOf(":") + 1);
}

export interface ChannelAdapter {
  /** Channel name, used as chatId prefix (e.g. "telegram") */
  name: string;
  /** Start listening. Calls onMessage for each inbound user message. */
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** Send a text message to a recipient. Adapter handles splitting internally. */
  sendMessage(chatId: string, text: string): Promise<void>;
  /** Optional typing indicator. */
  setTyping?(chatId: string, isTyping: boolean): Promise<void>;
  /** Whether the adapter is currently connected and able to send/receive. */
  isConnected(): boolean;
  /** Optional: query recent messages. Not all channels support this. */
  queryMessages?(opts?: QueryOptions): Promise<ChannelMessage[]>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}

export interface ChannelMessage {
  id: string;
  from: string;
  text: string;
  timestamp: Date;
  chatId?: string;
  subject?: string;
}

export interface QueryOptions {
  limit?: number;
  query?: string;
  unread?: boolean;
}
