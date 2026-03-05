import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { logger } from "../logger.ts";
import { stripPrefix, type ChannelAdapter, type InboundMessage } from "./adapter.ts";
import { authDir } from "./auth.ts";
import { splitMessage } from "./split.ts";

const AUTH_DIR = authDir("whatsapp");
const MAX_RECONNECT_DELAY = 60_000;

function extractText(message: any): string | undefined {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.editedMessage?.message?.protocolMessage?.editedMessage?.conversation
  );
}

function jidToPhone(jid: string): string {
  return jid.split("@")[0];
}

function phoneToJid(phone: string): string {
  return `${phone}@s.whatsapp.net`;
}

export class WhatsAppAdapter implements ChannelAdapter {
  name = "whatsapp" as const;
  private sock: ReturnType<typeof makeWASocket> | undefined;
  private onMessage?: (msg: InboundMessage) => Promise<void>;
  private reconnectDelay = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.sock) {
      this.sock.ev.removeAllListeners("creds.update");
      this.sock.ev.removeAllListeners("connection.update");
      this.sock.ev.removeAllListeners("messages.upsert");
      this.sock.end(undefined);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({ version, auth: state, printQRInTerminal: true });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect } = update;
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          logger.error("WhatsApp logged out — delete data/auth/whatsapp and re-scan QR");
          return;
        }
        if (this.stopped) return;

        logger.warn({ statusCode, delay: this.reconnectDelay }, "WhatsApp disconnected, reconnecting...");
        this.reconnectTimer = setTimeout(() => this.connect().catch((err) => {
          logger.error({ err }, "WhatsApp reconnection failed");
        }), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      } else if (connection === "open") {
        this.reconnectDelay = 1000;
        logger.info("WhatsApp connected");
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.key.remoteJid) continue;
        if (msg.key.remoteJid.endsWith("@g.us")) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        const phone = jidToPhone(msg.key.remoteJid);
        await this.onMessage?.({
          recipientId: `whatsapp:${phone}`,
          text,
        });
      }
    });
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    const phone = stripPrefix(recipientId);
    const jid = phoneToJid(phone);

    for (const chunk of splitMessage(text, 65536)) {
      await this.sock.sendMessage(jid, { text: chunk });
    }
  }

  async setTyping(recipientId: string, isTyping: boolean): Promise<void> {
    if (!this.sock) return;
    const phone = stripPrefix(recipientId);
    const jid = phoneToJid(phone);
    await this.sock.sendPresenceUpdate(isTyping ? "composing" : "paused", jid);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
  }
}
