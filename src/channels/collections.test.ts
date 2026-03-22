import { describe, expect, it } from "vitest";
import { evictOldest } from "./collections.ts";

describe("evictOldest", () => {
  it("does nothing when Set is at or below maxSize", () => {
    const s = new Set([1, 2, 3]);
    evictOldest(s, 5, 2);
    expect(s.size).toBe(3);
  });

  it("evicts oldest entries from a Set", () => {
    const s = new Set<number>();
    for (let i = 0; i < 10; i++) s.add(i);
    evictOldest(s, 5, 4);
    expect(s.size).toBe(6);
    // Oldest (0-3) should be gone
    expect(s.has(0)).toBe(false);
    expect(s.has(3)).toBe(false);
    // Newer entries remain
    expect(s.has(4)).toBe(true);
    expect(s.has(9)).toBe(true);
  });

  it("evicts oldest entries from a Map", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 10; i++) m.set(`k${i}`, i);
    evictOldest(m, 5, 4);
    expect(m.size).toBe(6);
    expect(m.has("k0")).toBe(false);
    expect(m.has("k3")).toBe(false);
    expect(m.has("k4")).toBe(true);
    expect(m.has("k9")).toBe(true);
  });

  it("handles evictCount larger than collection size", () => {
    const s = new Set([1, 2, 3]);
    evictOldest(s, 0, 100);
    expect(s.size).toBe(0);
  });

  it("does nothing when collection is exactly at maxSize", () => {
    const s = new Set([1, 2, 3]);
    evictOldest(s, 3, 1);
    expect(s.size).toBe(3);
  });
});
