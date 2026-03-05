export interface InboundMessage {
  recipientId: string;
  text: string;
}

/** Strip the channel prefix from a recipientId (e.g. "telegram:123" → "123"). */
export function stripPrefix(recipientId: string): string {
  return recipientId.slice(recipientId.indexOf(":") + 1);
}

export interface ChannelAdapter {
  /** Channel name, used as recipientId prefix (e.g. "telegram") */
  name: string;
  /** Start listening. Calls onMessage for each inbound user message. */
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** Send a text message to a recipient. Adapter handles splitting internally. */
  sendMessage(recipientId: string, text: string): Promise<void>;
  /** Optional typing indicator. */
  setTyping?(recipientId: string, isTyping: boolean): Promise<void>;
  /** Whether the adapter is currently connected and able to send/receive. */
  isConnected(): boolean;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}
