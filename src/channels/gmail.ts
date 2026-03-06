import * as fs from "node:fs/promises";
import * as path from "node:path";
import { google } from "googleapis";
import { logger } from "../logger.ts";
import {
  type ChannelAdapter,
  type ChannelMessage,
  type InboundMessage,
  type QueryOptions,
  stripPrefix,
} from "./adapter.ts";
import { authDir } from "./auth.ts";

const AUTH_DIR = authDir("gmail");
const CREDENTIALS_PATH = path.join(AUTH_DIR, "credentials.json");
const TOKEN_PATH = path.join(AUTH_DIR, "token.json");
const STATE_PATH = path.join(AUTH_DIR, "state.json");
const POLL_INTERVAL = 30_000;

function decodeBody(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

function extractPlainText(payload: any): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return "";
}

function getHeader(headers: any[], name: string): string | undefined {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

interface ThreadContext {
  subject: string;
  messageId: string;
  references?: string;
}

function buildRawEmail(
  to: string,
  from: string,
  subject: string,
  body: string,
  thread?: ThreadContext,
): string {
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (thread?.messageId) {
    lines.push(`In-Reply-To: ${thread.messageId}`);
    const refs = thread.references ? `${thread.references} ${thread.messageId}` : thread.messageId;
    lines.push(`References: ${refs}`);
  }
  lines.push("", body);
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

interface GmailAdapterOptions {
  label: string;
}

export class GmailAdapter implements ChannelAdapter {
  name = "gmail" as const;
  private gmail: any;
  private auth: any;
  private label: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private processedIds = new Set<string>();
  private threadContext = new Map<string, ThreadContext>();
  private onMessage?: (msg: InboundMessage) => Promise<void>;
  private myEmail?: string;

  constructor(opts: GmailAdapterOptions) {
    this.label = opts.label;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;

    const creds = JSON.parse(await fs.readFile(CREDENTIALS_PATH, "utf-8"));
    const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
    this.auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);

    try {
      const token = JSON.parse(await fs.readFile(TOKEN_PATH, "utf-8"));
      this.auth.setCredentials(token);
    } catch {
      logger.info("Gmail: No saved token. Run the OAuth2 flow first.");
      logger.info(
        `Visit: ${this.auth.generateAuthUrl({ access_type: "offline", scope: ["https://www.googleapis.com/auth/gmail.modify"] })}`,
      );
      throw new Error(
        "Gmail OAuth2 token not found. Complete the OAuth2 flow and save the token to data/auth/gmail/token.json.\n" +
          "Steps: 1) Visit the URL above  2) Authorize  3) Copy the auth code  " +
          "4) Exchange it: curl -d 'code=AUTH_CODE&client_id=ID&client_secret=SECRET&redirect_uri=URI&grant_type=authorization_code' https://oauth2.googleapis.com/token  " +
          "5) Save the JSON response to data/auth/gmail/token.json",
      );
    }

    this.auth.on("tokens", async (tokens: any) => {
      const existing = JSON.parse(await fs.readFile(TOKEN_PATH, "utf-8").catch(() => "{}"));
      await fs.writeFile(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }));
    });

    this.gmail = google.gmail({ version: "v1", auth: this.auth });

    const profile = await this.gmail.users.getProfile({ userId: "me" });
    this.myEmail = profile.data.emailAddress;
    logger.info({ email: this.myEmail, label: this.label }, "Gmail connected");

    // Load persisted state or do initial sync
    try {
      const state = JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));
      if (Array.isArray(state.processedIds)) {
        for (const id of state.processedIds) this.processedIds.add(id);
      }
    } catch {
      // No state file — first run. Mark existing unread as seen without processing.
      const res = await this.gmail.users.messages.list({
        userId: "me",
        q: `is:unread label:${this.label}`,
        maxResults: 100,
      });
      for (const { id } of res.data.messages || []) {
        this.processedIds.add(id);
      }
    }

    // Start polling
    this.pollTimer = setInterval(
      () =>
        this.poll().catch((err: any) => {
          logger.error({ err }, "Gmail poll error");
        }),
      POLL_INTERVAL,
    );
  }

  private async poll(): Promise<void> {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: `is:unread label:${this.label}`,
      maxResults: 10,
    });

    const messages = res.data.messages || [];
    for (const { id } of messages) {
      if (this.processedIds.has(id)) continue;
      this.processedIds.add(id);

      if (this.processedIds.size > 5000) {
        const iter = this.processedIds.values();
        for (let i = 0; i < 1000; i++) {
          const val = iter.next().value;
          if (val) this.processedIds.delete(val);
        }
      }
      if (this.threadContext.size > 1000) {
        const iter = this.threadContext.keys();
        for (let i = 0; i < 200; i++) {
          const key = iter.next().value;
          if (key) this.threadContext.delete(key);
        }
      }

      const msg = await this.gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      const from = getHeader(headers, "From") || "";
      if (this.myEmail && from.includes(this.myEmail)) continue;

      const text = extractPlainText(msg.data.payload);
      if (!text.trim()) continue;

      const emailMatch = from.match(/<(.+?)>/) || [null, from];
      const senderEmail = (emailMatch[1] || from).trim();

      const subject = getHeader(headers, "Subject") || "";
      const messageId = getHeader(headers, "Message-ID") || "";
      const references = getHeader(headers, "References");
      if (messageId) {
        this.threadContext.set(senderEmail, { subject, messageId, references });
      }

      await this.onMessage?.({
        chatId: `gmail:${senderEmail}`,
        text: text.trim(),
      });

      await this.gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    }

    await this.saveState();
  }

  private async saveState(): Promise<void> {
    try {
      await fs.writeFile(
        STATE_PATH,
        JSON.stringify({
          processedIds: [...this.processedIds],
        }),
      );
    } catch (err) {
      logger.warn({ err }, "Failed to save Gmail state");
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const to = stripPrefix(chatId);
    const thread = this.threadContext.get(to);
    const subject = thread
      ? `Re: ${thread.subject.replace(/^Re:\s*/i, "")}`
      : "Message from assistant";

    const raw = buildRawEmail(to, this.myEmail || "me", subject, text, thread);
    await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
  }

  async queryMessages(opts?: QueryOptions): Promise<ChannelMessage[]> {
    if (!this.gmail) throw new Error("Gmail not connected");

    let q = opts?.query || `label:${this.label}`;
    if (opts?.unread) q += " is:unread";

    const res = await this.gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: Math.min(opts?.limit ?? 10, 50),
    });

    const messages: ChannelMessage[] = [];
    for (const { id } of res.data.messages || []) {
      const msg = await this.gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      const from = getHeader(headers, "From") || "";
      const subject = getHeader(headers, "Subject") || undefined;
      const text = extractPlainText(msg.data.payload);

      messages.push({
        id,
        from,
        text: text.trim(),
        timestamp: new Date(Number(msg.data.internalDate)),
        subject,
      });
    }

    return messages;
  }

  isConnected(): boolean {
    return this.pollTimer !== undefined;
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    await this.saveState();
  }
}
