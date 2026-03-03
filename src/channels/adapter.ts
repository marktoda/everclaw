export interface InboundMessage {
  recipientId: string;
  text: string;
}

export interface ChannelAdapter {
  /** Channel name, used as recipientId prefix (e.g. "telegram") */
  name: string;
  /** Max characters per message for this platform */
  maxMessageLength: number;
  /** Start listening. Calls onMessage for each inbound user message. */
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** Send a text message to a recipient. Adapter handles splitting internally. */
  sendMessage(recipientId: string, text: string): Promise<void>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}
