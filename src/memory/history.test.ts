import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { appendMessage, getRecentMessages } from "./history.ts";

function createMockPool(rows: any[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

describe("appendMessage", () => {
  it("inserts a message with correct SQL and params", async () => {
    const pool = createMockPool();

    await appendMessage(pool, {
      chatId: "telegram:42",
      role: "user",
      content: "hello world",
    });

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO assistant.messages");
    expect(sql).toContain("chat_id, role, content, tool_use");
    expect(params).toEqual(["telegram:42", "user", "hello world", null]);
  });

  it("serialises toolUse as JSON when present", async () => {
    const pool = createMockPool();
    const toolUse = [{ id: "tu-1", name: "search", input: { q: "test" } }];

    await appendMessage(pool, {
      chatId: "telegram:1",
      role: "assistant",
      content: "using tool",
      toolUse,
    });

    const [, params] = pool.query.mock.calls[0];
    expect(params[3]).toBe(JSON.stringify(toolUse));
  });

  it("passes null for toolUse when undefined", async () => {
    const pool = createMockPool();

    await appendMessage(pool, {
      chatId: "telegram:1",
      role: "assistant",
      content: "result",
    });

    const [, params] = pool.query.mock.calls[0];
    expect(params[3]).toBeNull();
  });

  it("propagates query errors", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await expect(
      appendMessage(pool, { chatId: "telegram:1", role: "user", content: "hi" }),
    ).rejects.toThrow("connection lost");
  });
});

describe("getRecentMessages", () => {
  it("queries with correct chatId and default limit", async () => {
    const pool = createMockPool([]);

    await getRecentMessages(pool, "telegram:7");

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("WHERE chat_id = $1");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual(["telegram:7", 50]);
  });

  it("respects a custom limit", async () => {
    const pool = createMockPool([]);

    await getRecentMessages(pool, "telegram:7", 10);

    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual(["telegram:7", 10]);
  });

  it("maps rows and reverses DESC order to chronological", async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    // DB returns DESC order: newest first
    const pool = createMockPool([
      {
        id: 2,
        chat_id: "telegram:5",
        role: "assistant",
        content: "reply",
        tool_use: null,
        created_at: now,
      },
      {
        id: 1,
        chat_id: "telegram:5",
        role: "user",
        content: "hello",
        tool_use: null,
        created_at: earlier,
      },
    ]);

    const messages = await getRecentMessages(pool, "telegram:5");

    // After reverse: oldest first (chronological)
    expect(messages).toEqual([
      {
        id: 1,
        chatId: "telegram:5",
        role: "user",
        content: "hello",
        createdAt: earlier,
      },
      {
        id: 2,
        chatId: "telegram:5",
        role: "assistant",
        content: "reply",
        toolUse: undefined,
        createdAt: now,
      },
    ]);
  });

  it("returns an empty array when no rows exist", async () => {
    const pool = createMockPool([]);

    const messages = await getRecentMessages(pool, "telegram:99");

    expect(messages).toEqual([]);
  });

  it("maps tool_use from the database row to toolUse", async () => {
    const toolData = { name: "calc", input: { x: 1 } };
    const pool = createMockPool([
      {
        id: 10,
        chat_id: "telegram:3",
        role: "assistant",
        content: "computing",
        tool_use: toolData,
        created_at: new Date(),
      },
    ]);

    const [msg] = await getRecentMessages(pool, "telegram:3");

    expect((msg as import("./history.ts").AssistantMessage).toolUse).toEqual(toolData);
  });
});
