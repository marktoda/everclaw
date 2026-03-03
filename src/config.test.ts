import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  let tmpDir: string;
  let envPath: string;
  const origEnv = process.env;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-"));
    envPath = path.join(tmpDir, ".env");
    process.env = { ...origEnv };
  });
  afterEach(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws if .env file is missing required secrets", () => {
    fs.writeFileSync(envPath, "");
    expect(() => loadConfig(envPath)).toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("reads secrets from .env file, not process.env", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.channels).toEqual([{ type: "telegram", token: "tg" }]);
    expect(c.anthropicApiKey).toBe("sk");
    // Secrets should NOT be in process.env
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("returns config with defaults", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.databaseUrl).toContain("postgresql");
    expect(c.queueName).toBe("assistant");
    expect(c.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("populates scriptEnv with TOOL_* keys from .env", () => {
    fs.writeFileSync(
      envPath,
      "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\nTOOL_SOME_KEY=val1\nTOOL_OTHER=val2\n",
    );
    const c = loadConfig(envPath);
    expect(c.scriptEnv).toEqual({ TOOL_SOME_KEY: "val1", TOOL_OTHER: "val2" });
  });

  it("excludes non-TOOL keys from scriptEnv", () => {
    fs.writeFileSync(
      envPath,
      "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\nBRAVE_SEARCH_API_KEY=brave\n",
    );
    const c = loadConfig(envPath);
    expect(c.scriptEnv).toEqual({});
  });
});
