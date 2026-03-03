import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig } from "./config.js";

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
    expect(c.telegramToken).toBe("tg");
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
});
