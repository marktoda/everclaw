import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDb } from "./harness.ts";
import { setupTestDb } from "./harness.ts";

let db: TestDb;

beforeAll(async () => {
  db = await setupTestDb();
}, 60_000);

afterAll(async () => {
  await db?.teardown();
});

describe("test harness", () => {
  it("creates assistant.messages table", async () => {
    const result = await db.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'assistant' AND table_name = 'messages'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].table_name).toBe("messages");
  });

  it("creates absurd queue", async () => {
    const queues = await db.absurd.listQueues();
    expect(queues).toContain("test");
  });

  it("can insert and query messages", async () => {
    await db.pool.query(
      `INSERT INTO assistant.messages (chat_id, role, content)
       VALUES ($1, $2, $3)`,
      [12345, "user", "hello world"],
    );

    const result = await db.pool.query(
      `SELECT chat_id, role, content FROM assistant.messages
       WHERE chat_id = $1`,
      [12345],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      chat_id: "12345",
      role: "user",
      content: "hello world",
    });
  });

  it("can spawn tasks via absurd", async () => {
    db.absurd.registerTask({ name: "test-task" }, async () => {
      return "done";
    });

    const spawnResult = await db.absurd.spawn("test-task", { foo: "bar" });
    expect(spawnResult.taskID).toBeDefined();
    expect(typeof spawnResult.taskID).toBe("string");
  });
});
