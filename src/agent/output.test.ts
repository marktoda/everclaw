// src/agent/output.test.ts
import { describe, expect, it } from "vitest";
import { stripInternalTags } from "./output.ts";

describe("stripInternalTags", () => {
  it("removes internal tags", () => {
    expect(stripInternalTags("Hello <internal>thinking...</internal> world")).toBe("Hello  world");
  });

  it("removes multiline internal blocks", () => {
    const input = "Hi\n<internal>\nLet me think\nabout this\n</internal>\nDone";
    expect(stripInternalTags(input)).toBe("Hi\n\nDone");
  });

  it("handles multiple internal blocks", () => {
    expect(stripInternalTags("<internal>a</internal>Hi<internal>b</internal>")).toBe("Hi");
  });

  it("passes through text without internal tags", () => {
    expect(stripInternalTags("Just normal text")).toBe("Just normal text");
  });
});
