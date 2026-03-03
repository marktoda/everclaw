import { describe, expect, it } from "vitest";
import { splitMessage } from "./split.ts";

describe("splitMessage", () => {
  it("returns text as-is when under the limit", () => {
    expect(splitMessage("short", 100)).toEqual(["short"]);
  });

  it("returns text as-is when exactly at the limit", () => {
    const text = "a".repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });

  it("splits at paragraph boundary when possible", () => {
    const text = `${"a".repeat(50)}\n\n${"b".repeat(60)}`;
    const chunks = splitMessage(text, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(60));
  });

  it("falls back to line boundary when no paragraph break", () => {
    const text = `${"a".repeat(50)}\n${"b".repeat(60)}`;
    const chunks = splitMessage(text, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(60));
  });

  it("hard-splits when no newlines available", () => {
    const text = "a".repeat(200);
    const chunks = splitMessage(text, 80);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("a".repeat(80));
    expect(chunks[1]).toBe("a".repeat(80));
    expect(chunks[2]).toBe("a".repeat(40));
  });

  it("strips leading newlines from subsequent chunks", () => {
    const text = `${"a".repeat(50)}\n\n\n${"b".repeat(30)}`;
    const chunks = splitMessage(text, 60);
    expect(chunks[1]).toBe("b".repeat(30));
    expect(chunks[1]).not.toMatch(/^\n/);
  });

  it("handles empty string", () => {
    expect(splitMessage("", 100)).toEqual([""]);
  });

  it("works with Telegram's 4096 limit", () => {
    const text = "x".repeat(5000);
    const chunks = splitMessage(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(904);
  });
});
