import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { authDir } from "./auth.ts";

describe("authDir", () => {
  it("returns absolute path under data/auth/{adapter}", () => {
    const dir = authDir("whatsapp");
    expect(dir).toBe(path.resolve("data/auth/whatsapp"));
  });

  it("works for any adapter name", () => {
    const dir = authDir("gmail");
    expect(dir).toBe(path.resolve("data/auth/gmail"));
  });
});
