import { describe, it, expect, vi } from "vitest";
import { getState, setState, deleteState, listState } from "./state.js";
import type { Pool } from "pg";

function createMockPool(rows: any[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

describe("getState", () => {
  it("returns the value when a row is found", async () => {
    const pool = createMockPool([{ value: { count: 42 } }]);

    const result = await getState(pool, "ns", "counter");

    expect(result).toEqual({ count: 42 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("SELECT value FROM assistant.state");
    expect(sql).toContain("namespace = $1");
    expect(sql).toContain("key = $2");
    expect(params).toEqual(["ns", "counter"]);
  });

  it("returns null when no row is found", async () => {
    const pool = createMockPool([]);

    const result = await getState(pool, "ns", "missing");

    expect(result).toBeNull();
  });

  it("returns primitive values correctly", async () => {
    const pool = createMockPool([{ value: "hello" }]);

    const result = await getState(pool, "ns", "greeting");

    expect(result).toBe("hello");
  });

  it("propagates query errors", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("timeout"));

    await expect(getState(pool, "ns", "key")).rejects.toThrow("timeout");
  });
});

describe("setState", () => {
  it("upserts with correct SQL and JSON-serialised value", async () => {
    const pool = createMockPool();
    const value = { enabled: true, tags: ["a", "b"] };

    await setState(pool, "config", "feature", value);

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO assistant.state");
    expect(sql).toContain("ON CONFLICT (namespace, key) DO UPDATE");
    expect(params).toEqual(["config", "feature", JSON.stringify(value)]);
  });

  it("serialises string values as JSON", async () => {
    const pool = createMockPool();

    await setState(pool, "ns", "key", "plain string");

    const [, params] = pool.query.mock.calls[0];
    expect(params[2]).toBe(JSON.stringify("plain string"));
  });

  it("serialises numeric values as JSON", async () => {
    const pool = createMockPool();

    await setState(pool, "ns", "key", 123);

    const [, params] = pool.query.mock.calls[0];
    expect(params[2]).toBe("123");
  });

  it("propagates query errors", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("unique violation"));

    await expect(
      setState(pool, "ns", "key", "val"),
    ).rejects.toThrow("unique violation");
  });
});

describe("deleteState", () => {
  it("deletes with correct namespace and key", async () => {
    const pool = createMockPool();

    await deleteState(pool, "session", "token");

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("DELETE FROM assistant.state");
    expect(sql).toContain("namespace = $1");
    expect(sql).toContain("key = $2");
    expect(params).toEqual(["session", "token"]);
  });

  it("does not throw when deleting a non-existent key", async () => {
    const pool = createMockPool();

    await expect(deleteState(pool, "ns", "ghost")).resolves.toBeUndefined();
  });

  it("propagates query errors", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      deleteState(pool, "ns", "key"),
    ).rejects.toThrow("permission denied");
  });
});

describe("listState", () => {
  it("lists keys in a namespace ordered by key", async () => {
    const rows = [
      { key: "alpha", value: 1 },
      { key: "beta", value: 2 },
    ];
    const pool = createMockPool(rows);

    const result = await listState(pool, "myns");

    expect(result).toEqual(rows);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("SELECT key, value FROM assistant.state");
    expect(sql).toContain("WHERE namespace = $1");
    expect(sql).toContain("ORDER BY key");
    expect(params).toEqual(["myns"]);
  });

  it("returns an empty array when namespace has no keys", async () => {
    const pool = createMockPool([]);

    const result = await listState(pool, "empty");

    expect(result).toEqual([]);
  });

  it("propagates query errors", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("relation does not exist"));

    await expect(listState(pool, "ns")).rejects.toThrow(
      "relation does not exist",
    );
  });
});
