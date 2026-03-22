import { describe, expect, it } from "vitest";
import { baseChildEnv } from "./child-env.ts";

describe("baseChildEnv", () => {
  it("returns PATH and HOME from process.env", () => {
    const env = baseChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("does not include other process.env vars", () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    try {
      const env = baseChildEnv();
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("merges extra vars when provided", () => {
    const env = baseChildEnv({ TOOL_KEY: "abc" });
    expect(env.TOOL_KEY).toBe("abc");
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("allows extra vars to override PATH and HOME", () => {
    const env = baseChildEnv({ PATH: "/custom/bin", HOME: "/custom/home" });
    expect(env.PATH).toBe("/custom/bin");
    expect(env.HOME).toBe("/custom/home");
  });

  it("defaults PATH and HOME to empty string when unset", () => {
    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    delete process.env.PATH;
    delete process.env.HOME;
    try {
      const env = baseChildEnv();
      expect(env.PATH).toBe("");
      expect(env.HOME).toBe("");
    } finally {
      process.env.PATH = origPath;
      process.env.HOME = origHome;
    }
  });
});
