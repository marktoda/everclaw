import { describe, expect, it } from "vitest";
import { tokenize } from "./browser.ts";

describe("tokenize", () => {
  it("splits simple words", () => {
    expect(tokenize("open https://example.com")).toEqual(["open", "https://example.com"]);
  });

  it("handles double-quoted strings", () => {
    expect(tokenize('fill @e3 "hello world"')).toEqual(["fill", "@e3", "hello world"]);
  });

  it("handles single-quoted strings", () => {
    expect(tokenize("fill @e3 'hello world'")).toEqual(["fill", "@e3", "hello world"]);
  });

  it("collapses multiple spaces", () => {
    expect(tokenize("click   @e1")).toEqual(["click", "@e1"]);
  });

  it("handles tabs", () => {
    expect(tokenize("get\ttext\t@e1")).toEqual(["get", "text", "@e1"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("handles quoted string at start", () => {
    expect(tokenize('"hello world"')).toEqual(["hello world"]);
  });

  it("handles single quotes inside double quotes", () => {
    expect(tokenize('fill @e3 "it\'s here"')).toEqual(["fill", "@e3", "it's here"]);
  });

  it("includes partial token on unclosed quote", () => {
    expect(tokenize('fill @e3 "unclosed')).toEqual(["fill", "@e3", "unclosed"]);
  });
});
