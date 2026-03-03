// src/memory/history.ts
import type { Pool } from "pg";

export interface Message {
  id?: number;
  chatId: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolUse?: any;
  createdAt?: Date;
}

export async function appendMessage(pool: Pool, msg: Message): Promise<void> {
  await pool.query(
    `INSERT INTO assistant.messages (chat_id, role, content, tool_use)
     VALUES ($1, $2, $3, $4)`,
    [msg.chatId, msg.role, msg.content, msg.toolUse ? JSON.stringify(msg.toolUse) : null],
  );
}

export async function getRecentMessages(
  pool: Pool, chatId: number, limit: number = 50,
): Promise<Message[]> {
  const result = await pool.query(
    `SELECT id, chat_id, role, content, tool_use, created_at
     FROM assistant.messages WHERE chat_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [chatId, limit],
  );
  return result.rows.reverse().map((r) => ({
    id: r.id, chatId: r.chat_id, role: r.role,
    content: r.content, toolUse: r.tool_use, createdAt: r.created_at,
  }));
}
