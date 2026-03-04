import { describe, expect, it } from "vitest";
import { createAdapter } from "./adapters.ts";

describe("createAdapter", () => {
  it("creates a TelegramAdapter for type 'telegram'", () => {
    const adapter = createAdapter("telegram", "fake-token");
    expect(adapter.name).toBe("telegram");
  });

  it("throws for unknown channel type", () => {
    expect(() => createAdapter("carrier-pigeon", "token")).toThrow("Unknown channel type");
  });
});
