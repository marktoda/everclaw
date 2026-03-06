import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { logger } from "../logger.ts";
import { type ChannelAdapter, type InboundMessage, stripPrefix } from "./adapter.ts";
import { authDir } from "./auth.ts";
import { splitMessage } from "./split.ts";

const AUTH_DIR = authDir("whatsapp");
const MAX_MESSAGE_LENGTH = 65536;
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
  private connected = false;
  private sentIds = new Set<string>();
  private lidToPhone = new Map<string, string>();

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

    this.sock = makeWASocket({ version, auth: state });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info("Scan this QR code with WhatsApp:");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "close") {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          logger.error("WhatsApp logged out — delete data/auth/whatsapp and re-scan QR");
          return;
        }
        if (this.stopped) return;

        logger.warn(
          { statusCode, delay: this.reconnectDelay },
          "WhatsApp disconnected, reconnecting...",
        );
        this.reconnectTimer = setTimeout(
          () =>
            this.connect().catch((err) => {
              logger.error({ err }, "WhatsApp reconnection failed");
            }),
          this.reconnectDelay,
        );
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      } else if (connection === "open") {
        this.connected = true;
        this.reconnectDelay = 1000;

        // Build LID→phone mapping for self-chat translation
        const user = (this.sock as any)?.user;
        if (user?.id && user?.lid) {
          const phone = user.id.split(":")[0];
          const lid = user.lid.split(":")[0];
          this.lidToPhone.set(lid, phone);
          logger.info({ lid, phone }, "LID→phone mapping set");
        }

        logger.info("WhatsApp connected");
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.id && this.sentIds.delete(msg.key.id)) continue;
        if (!msg.key.remoteJid) continue;
        if (msg.key.remoteJid.endsWith("@g.us")) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        const jid = this.translateJid(msg.key.remoteJid);
        const phone = jidToPhone(jid);
        await this.onMessage?.({
          chatId: `whatsapp:${phone}`,
          text,
        });
      }
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    const phone = stripPrefix(chatId);
    const jid = phoneToJid(phone);

    for (const chunk of splitMessage(text, MAX_MESSAGE_LENGTH)) {
      const sent = await this.sock.sendMessage(jid, { text: chunk });
      if (sent?.key?.id) {
        this.sentIds.add(sent.key.id);
        // Evict oldest entries to prevent unbounded growth
        if (this.sentIds.size > 5000) {
          const iter = this.sentIds.values();
          for (let i = 0; i < 1000; i++) {
            const val = iter.next().value;
            if (val) this.sentIds.delete(val);
          }
        }
      }
    }
  }

  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    if (!this.sock) return;
    const phone = stripPrefix(chatId);
    const jid = phoneToJid(phone);
    await this.sock.sendPresenceUpdate(isTyping ? "composing" : "paused", jid);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private translateJid(jid: string): string {
    if (!jid.endsWith("@lid")) return jid;
    const lidUser = jid.split("@")[0].split(":")[0];
    const phone = this.lidToPhone.get(lidUser);
    if (phone) return phoneToJid(phone);
    return jid;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
  }
}
