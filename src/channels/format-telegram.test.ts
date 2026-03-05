import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format-telegram.ts";

describe("markdownToTelegramHtml", () => {
  it("escapes HTML entities", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe(
      "a &lt; b &amp; c &gt; d",
    );
  });

  describe("code", () => {
    it("converts fenced code blocks to <pre><code>", () => {
      const md = "```ts\nconst x = 1;\n```";
      expect(markdownToTelegramHtml(md)).toBe(
        '<pre><code language="ts">const x = 1;</code></pre>',
      );
    });

    it("handles fenced code blocks without language", () => {
      const md = "```\nhello\n```";
      expect(markdownToTelegramHtml(md)).toBe("<pre><code>hello</code></pre>");
    });

    it("converts inline code to <code>", () => {
      expect(markdownToTelegramHtml("use `foo()` here")).toBe(
        "use <code>foo()</code> here",
      );
    });

    it("does not apply inline rules inside code blocks", () => {
      const md = "```\n**bold** and *italic*\n```";
      expect(markdownToTelegramHtml(md)).toBe(
        "<pre><code>**bold** and *italic*</code></pre>",
      );
    });

    it("does not apply inline rules inside inline code", () => {
      expect(markdownToTelegramHtml("`**not bold**`")).toBe(
        "<code>**not bold**</code>",
      );
    });
  });

  describe("block rules", () => {
    it("converts headings to bold", () => {
      expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
      expect(markdownToTelegramHtml("### Sub")).toBe("<b>Sub</b>");
    });

    it("removes horizontal rules", () => {
      expect(markdownToTelegramHtml("above\n\n---\n\nbelow")).toBe(
        "above\n\nbelow",
      );
    });

    it("converts blockquotes", () => {
      expect(markdownToTelegramHtml("> hello\n> world")).toBe(
        "<blockquote>hello\nworld</blockquote>",
      );
    });

    it("converts unordered list items to bullet", () => {
      const md = "- one\n- two\n- three";
      expect(markdownToTelegramHtml(md)).toBe(
        "\u2022 one\n\u2022 two\n\u2022 three",
      );
    });

    it("handles * and + list markers", () => {
      expect(markdownToTelegramHtml("* item")).toBe("\u2022 item");
      expect(markdownToTelegramHtml("+ item")).toBe("\u2022 item");
    });
  });

  describe("inline rules", () => {
    it("converts bold", () => {
      expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
    });

    it("converts italic", () => {
      expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
    });

    it("converts strikethrough", () => {
      expect(markdownToTelegramHtml("~~strike~~")).toBe("<s>strike</s>");
    });

    it("converts links", () => {
      expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
        '<a href="https://example.com">click</a>',
      );
    });

    it("converts images to links", () => {
      expect(markdownToTelegramHtml("![alt](https://img.png)")).toBe(
        '<a href="https://img.png">alt</a>',
      );
    });

    it("handles bold and italic together", () => {
      expect(markdownToTelegramHtml("**bold** and *italic*")).toBe(
        "<b>bold</b> and <i>italic</i>",
      );
    });
  });

  it("handles a complex message", () => {
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

    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<b>Summary</b>");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<i>italic</i>");
    expect(html).toContain('<pre><code language="ts">const x = 1;</code></pre>');
    expect(html).toContain("<blockquote>A quote</blockquote>");
    expect(html).toContain("\u2022 item one");
    expect(html).toContain("\u2022 item two");
  });

  it("passes through plain text unchanged (after entity escaping)", () => {
    expect(markdownToTelegramHtml("just plain text")).toBe("just plain text");
  });
});
