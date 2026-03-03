// src/memory/history.ts
import type { Pool } from "pg";

export interface BaseMessage {
  id?: number;
  recipientId: string;
  content: string;
  createdAt?: Date;
}

export interface UserMessage extends BaseMessage {
  role: "user";
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  toolUse?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

export interface ToolResultMessage extends BaseMessage {
  role: "tool";
  toolUse: Array<{ tool_use_id: string; content: string }>;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export async function appendMessage(pool: Pool, msg: Message): Promise<void> {
  const toolUse = msg.role === "assistant" || msg.role === "tool" ? msg.toolUse : undefined;
  await pool.query(
    `INSERT INTO assistant.messages (chat_id, role, content, tool_use)
     VALUES ($1, $2, $3, $4)`,
    [msg.recipientId, msg.role, msg.content, toolUse ? JSON.stringify(toolUse) : null],
  );
}

export async function getRecentMessages(
  pool: Pool, recipientId: string, limit: number = 50,
): Promise<Message[]> {
  const result = await pool.query(
    `SELECT id, chat_id, role, content, tool_use, created_at
     FROM assistant.messages WHERE chat_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [recipientId, limit],
  );
  return result.rows.reverse().map((r): Message => {
    const base = { id: r.id, recipientId: r.chat_id as string, content: r.content, createdAt: r.created_at };
    if (r.role === "tool") return { ...base, role: "tool", toolUse: r.tool_use ?? [] };
    if (r.role === "assistant") return { ...base, role: "assistant", toolUse: r.tool_use ?? undefined };
    return { ...base, role: "user" };
  });
}
