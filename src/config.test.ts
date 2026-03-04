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

  it("parses EXTRA_DIRS into extraDirs array", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:/mnt/vaults,projects:rw:/mnt/projects";
    const c = loadConfig(envPath);
    expect(c.extraDirs).toEqual([
      { name: "vaults", mode: "ro", absPath: "/mnt/vaults" },
      { name: "projects", mode: "rw", absPath: "/mnt/projects" },
    ]);
  });

  it("defaults extraDirs to empty array when EXTRA_DIRS is not set", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.extraDirs).toEqual([]);
  });

  it("throws on invalid EXTRA_DIRS name", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "../bad:ro:/mnt/bad";
    expect(() => loadConfig(envPath)).toThrow("Invalid extra dir name");
  });

  it("throws on EXTRA_DIRS name colliding with built-in prefix", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "skills:rw:/mnt/skills";
    expect(() => loadConfig(envPath)).toThrow("conflicts with built-in");
  });

  it("throws on invalid EXTRA_DIRS mode", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:xx:/mnt/vaults";
    expect(() => loadConfig(envPath)).toThrow("mode must be");
  });

  it("throws on non-absolute EXTRA_DIRS path", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:relative/path";
    expect(() => loadConfig(envPath)).toThrow("must be absolute");
  });

  it("throws on duplicate EXTRA_DIRS names", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:/mnt/a,vaults:rw:/mnt/b";
    expect(() => loadConfig(envPath)).toThrow("duplicate");
  });

  it("returns empty extraDirs for empty string EXTRA_DIRS", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "";
    const c = loadConfig(envPath);
    expect(c.extraDirs).toEqual([]);
  });

  it("parses a single EXTRA_DIRS entry without comma", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:/mnt/vaults";
    const c = loadConfig(envPath);
    expect(c.extraDirs).toEqual([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
  });

  it("throws on malformed EXTRA_DIRS entry with too few colons", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro";
    expect(() => loadConfig(envPath)).toThrow("expected name:mode:path");
  });

  it("returns empty allowedChatIds when ALLOWED_CHAT_IDS is not set", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.allowedChatIds).toEqual(new Set());
  });

  it("parses ALLOWED_CHAT_IDS into prefixed Set", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\nALLOWED_CHAT_IDS=123,456\n");
    const c = loadConfig(envPath);
    expect(c.allowedChatIds).toEqual(new Set(["telegram:123", "telegram:456"]));
  });

  it("trims whitespace in ALLOWED_CHAT_IDS", () => {
    fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=tg\nANTHROPIC_API_KEY=sk\nALLOWED_CHAT_IDS= 123 , 456 \n");
    const c = loadConfig(envPath);
    expect(c.allowedChatIds).toEqual(new Set(["telegram:123", "telegram:456"]));
  });
});
