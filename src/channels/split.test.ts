import { describe, expect, it } from "vitest";
import { splitMessage, splitWithEntities } from "./split.ts";
import type { FormattedMessage, TelegramEntity } from "./format-telegram.ts";

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

describe("splitWithEntities", () => {
  it("returns single chunk when under limit", () => {
    const msg: FormattedMessage = {
      text: "short",
      entities: [{ type: "bold", offset: 0, length: 5 }],
    };
    const chunks = splitWithEntities(msg, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("short");
    expect(chunks[0].entities).toEqual([{ type: "bold", offset: 0, length: 5 }]);
  });

  it("splits text and adjusts entity offsets", () => {
    const text = `${"a".repeat(50)}\n\n${"b".repeat(60)}`;
    const msg: FormattedMessage = {
      text,
      entities: [{ type: "bold", offset: 52, length: 60 }],
    };
    const chunks = splitWithEntities(msg, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].entities).toEqual([]);
    expect(chunks[1].entities).toEqual([{ type: "bold", offset: 0, length: 60 }]);
  });

  it("clips entity that spans chunk boundary", () => {
    const text = `${"a".repeat(40)}\n\n${"b".repeat(40)}`;
    // Bold spans from offset 30 to 70 (crosses the split at 40)
    const msg: FormattedMessage = {
      text,
      entities: [{ type: "bold", offset: 30, length: 40 }],
    };
    const chunks = splitWithEntities(msg, 50);
    expect(chunks).toHaveLength(2);
    // First chunk: bold from 30 to 40 (length 10)
    expect(chunks[0].entities).toEqual([{ type: "bold", offset: 30, length: 10 }]);
    // Second chunk: bold from 0, continuing
    expect(chunks[1].entities[0].type).toBe("bold");
    expect(chunks[1].entities[0].offset).toBe(0);
  });

  it("preserves extra fields (url, language) when clipping entities", () => {
    const text = `${"a".repeat(50)}\n\n${"b".repeat(60)}`;
    const msg: FormattedMessage = {
      text,
      entities: [{ type: "text_link", offset: 0, length: 5, url: "https://example.com" } as TelegramEntity],
    };
    const chunks = splitWithEntities(msg, 80);
    expect(chunks[0].entities[0]).toEqual({
      type: "text_link", offset: 0, length: 5, url: "https://example.com",
    });
  });

  it("does not split in middle of surrogate pair", () => {
    const text = "a".repeat(4094) + "😄" + "b";
    const msg: FormattedMessage = { text, entities: [] };
    const chunks = splitWithEntities(msg, 4096);
    expect(chunks).toHaveLength(2);
    // Verify no broken surrogates
    expect(chunks[0].text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(chunks[1].text).not.toMatch(/^[\uDC00-\uDFFF]/);
  });

  it("handles empty message", () => {
    const msg: FormattedMessage = { text: "", entities: [] };
    const chunks = splitWithEntities(msg, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ text: "", entities: [] });
  });
});
