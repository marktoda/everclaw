import { describe, expect, it } from "vitest";
import { markdownToEntities } from "./format-telegram.ts";

describe("markdownToEntities", () => {
  it("returns plain text with no entities for simple text", () => {
    const result = markdownToEntities("hello world");
    expect(result.text).toBe("hello world");
    expect(result.entities).toEqual([]);
  });

  it("converts bold to bold entity", () => {
    const result = markdownToEntities("**bold**");
    expect(result.text).toBe("bold");
    expect(result.entities).toEqual([{ type: "bold", offset: 0, length: 4 }]);
  });

  it("converts italic to italic entity", () => {
    const result = markdownToEntities("*italic*");
    expect(result.text).toBe("italic");
    expect(result.entities).toEqual([{ type: "italic", offset: 0, length: 6 }]);
  });

  it("converts strikethrough to strikethrough entity", () => {
    const result = markdownToEntities("~~strike~~");
    expect(result.text).toBe("strike");
    expect(result.entities).toEqual([{ type: "strikethrough", offset: 0, length: 6 }]);
  });

  it("converts inline code to code entity", () => {
    const result = markdownToEntities("use `foo()` here");
    expect(result.text).toBe("use foo() here");
    expect(result.entities).toEqual([{ type: "code", offset: 4, length: 5 }]);
  });

  it("converts fenced code block to pre entity with language", () => {
    const result = markdownToEntities("```ts\nconst x = 1;\n```");
    expect(result.text).toBe("const x = 1;");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 12, language: "ts" }]);
  });

  it("converts fenced code block without language", () => {
    const result = markdownToEntities("```\nhello\n```");
    expect(result.text).toBe("hello");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 5 }]);
  });

  it("converts links to text_link entity", () => {
    const result = markdownToEntities("[click](https://example.com)");
    expect(result.text).toBe("click");
    expect(result.entities).toEqual([
      { type: "text_link", offset: 0, length: 5, url: "https://example.com" },
    ]);
  });

  it("converts images to text_link entity using alt text", () => {
    const result = markdownToEntities("![photo](https://img.png)");
    expect(result.text).toBe("photo");
    expect(result.entities).toEqual([
      { type: "text_link", offset: 0, length: 5, url: "https://img.png" },
    ]);
  });

  it("converts headings to bold entity", () => {
    const result = markdownToEntities("# Title");
    expect(result.text).toBe("Title");
    expect(result.entities).toEqual([{ type: "bold", offset: 0, length: 5 }]);
  });

  it("does not produce nested bold for bold text inside heading", () => {
    const result = markdownToEntities("## **Bold Heading**");
    expect(result.text).toBe("Bold Heading");
    // Should be a single bold entity, not two nested ones
    expect(result.entities).toEqual([{ type: "bold", offset: 0, length: 12 }]);
  });

  it("converts blockquotes to blockquote entity", () => {
    const result = markdownToEntities("> quoted text");
    expect(result.text).toBe("quoted text");
    expect(result.entities).toEqual([{ type: "blockquote", offset: 0, length: 11 }]);
  });

  it("converts unordered list items to bullets", () => {
    const result = markdownToEntities("- one\n- two");
    expect(result.text).toContain("• one");
    expect(result.text).toContain("• two");
  });

  it("preserves ordered list numbering", () => {
    const result = markdownToEntities("1. first\n2. second");
    expect(result.text).toContain("1. first");
    expect(result.text).toContain("2. second");
  });

  it("converts horizontal rule to empty line", () => {
    const result = markdownToEntities("above\n\n---\n\nbelow");
    expect(result.text).toContain("above");
    expect(result.text).toContain("below");
    expect(result.entities.every((e: any) => e.type !== "hr")).toBe(true);
  });

  it("handles bold and italic together", () => {
    const result = markdownToEntities("**bold** and *italic*");
    expect(result.text).toBe("bold and italic");
    expect(result.entities).toEqual([
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 9, length: 6 },
    ]);
  });

  it("separates paragraphs with double newline", () => {
    const result = markdownToEntities("first\n\nsecond");
    expect(result.text).toBe("first\n\nsecond");
  });

  it("handles complex message with multiple constructs", () => {
    const md = [
      "# Summary",
      "",
      "Here's some **bold** and *italic* text.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "> A quote",
      "",
      "- item one",
      "- item two",
    ].join("\n");

    const result = markdownToEntities(md);
    expect(result.text).toContain("Summary");
    expect(result.text).toContain("bold");
    expect(result.text).toContain("italic");
    expect(result.text).toContain("const x = 1;");
    expect(result.text).toContain("A quote");
    expect(result.text).toContain("• item one");

    const types = result.entities.map((e) => e.type);
    expect(types).toContain("bold");
    expect(types).toContain("italic");
    expect(types).toContain("pre");
    expect(types).toContain("blockquote");
  });

  it("handles emoji correctly (UTF-16 offsets)", () => {
    const result = markdownToEntities("Hello 😄 **world**");
    expect(result.text).toBe("Hello 😄 world");
    const bold = result.entities.find((e) => e.type === "bold");
    expect(bold).toEqual({ type: "bold", offset: 9, length: 5 });
  });
});
