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
    expect(() => loadConfig(envPath)).toThrow("ANTHROPIC_API_KEY");
  });

  it("reads secrets from .env file, not process.env", () => {
    fs.writeFileSync(envPath, "CHANNEL_TELEGRAM=tg\nANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.channels).toEqual([{ type: "telegram", token: "tg" }]);
    expect(c.anthropicApiKey).toBe("sk");
    // Secrets should NOT be in process.env
    expect(process.env.CHANNEL_TELEGRAM).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("returns config with defaults", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.worker.databaseUrl).toContain("postgresql");
    expect(c.worker.queueName).toBe("assistant");
    expect(c.agent.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("populates scriptEnv with SCRIPT_* keys from .env", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\nSCRIPT_SOME_KEY=val1\nSCRIPT_OTHER=val2\n");
    const c = loadConfig(envPath);
    expect(c.scriptEnv).toEqual({ SOME_KEY: "val1", OTHER: "val2" });
  });

  it("excludes non-SCRIPT keys from scriptEnv", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\nBRAVE_SEARCH_API_KEY=brave\n");
    const c = loadConfig(envPath);
    expect(c.scriptEnv).toEqual({});
  });

  it("populates serverEnv with SERVER_* keys, prefix stripped", () => {
    fs.writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=sk\nSERVER_GITHUB_TOKEN=gh123\nSERVER_OTHER=val\n",
    );
    const c = loadConfig(envPath);
    expect(c.serverEnv).toEqual({ GITHUB_TOKEN: "gh123", OTHER: "val" });
  });

  it("excludes non-SERVER keys from serverEnv", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\nSCRIPT_X=val\nBRAVE_SEARCH_API_KEY=brave\n");
    const c = loadConfig(envPath);
    expect(c.serverEnv).toEqual({});
  });

  it("parses EXTRA_DIRS into dirs.extra array", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:/mnt/vaults,projects:rw:/mnt/projects";
    const c = loadConfig(envPath);
    expect(c.dirs.extra).toEqual([
      { name: "vaults", mode: "ro", absPath: "/mnt/vaults" },
      { name: "projects", mode: "rw", absPath: "/mnt/projects" },
    ]);
  });

  it("defaults dirs.extra to empty array when EXTRA_DIRS is not set", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.dirs.extra).toEqual([]);
  });

  it("throws on invalid EXTRA_DIRS name", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "../bad:ro:/mnt/bad";
    expect(() => loadConfig(envPath)).toThrow("Invalid extra dir name");
  });

  it("throws on EXTRA_DIRS name colliding with built-in prefix", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "skills:rw:/mnt/skills";
    expect(() => loadConfig(envPath)).toThrow("conflicts with built-in");
  });

  it("throws on invalid EXTRA_DIRS mode", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:xx:/mnt/vaults";
    expect(() => loadConfig(envPath)).toThrow("mode must be");
  });

  it("throws on non-absolute EXTRA_DIRS path", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:relative/path";
    expect(() => loadConfig(envPath)).toThrow("must be absolute");
  });

  it("throws on duplicate EXTRA_DIRS names", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:/mnt/a,vaults:rw:/mnt/b";
    expect(() => loadConfig(envPath)).toThrow("duplicate");
  });

  it("returns empty dirs.extra for empty string EXTRA_DIRS", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "";
    const c = loadConfig(envPath);
    expect(c.dirs.extra).toEqual([]);
  });

  it("parses a single EXTRA_DIRS entry without comma", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro:/mnt/vaults";
    const c = loadConfig(envPath);
    expect(c.dirs.extra).toEqual([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
  });

  it("throws on malformed EXTRA_DIRS entry with too few colons", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    process.env.EXTRA_DIRS = "vaults:ro";
    expect(() => loadConfig(envPath)).toThrow("expected name:mode:path");
  });

  it("returns empty allowedChatIds when ALLOWED_CHAT_IDS is not set", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.allowedChatIds).toEqual(new Set());
  });

  it("parses ALLOWED_CHAT_IDS with prefixes as-is", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\nALLOWED_CHAT_IDS=telegram:123,telegram:456\n");
    const c = loadConfig(envPath);
    expect(c.allowedChatIds).toEqual(new Set(["telegram:123", "telegram:456"]));
  });

  it("trims whitespace in ALLOWED_CHAT_IDS", () => {
    fs.writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=sk\nALLOWED_CHAT_IDS= telegram:123 , telegram:456 \n",
    );
    const c = loadConfig(envPath);
    expect(c.allowedChatIds).toEqual(new Set(["telegram:123", "telegram:456"]));
  });

  it("parses ALLOWED_CHAT_IDS with mixed prefixes", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\nALLOWED_CHAT_IDS=telegram:123,discord:456\n");
    const c = loadConfig(envPath);
    expect(c.allowedChatIds).toEqual(new Set(["telegram:123", "discord:456"]));
  });

  it("auto-detects multiple channels from CHANNEL_* keys", () => {
    fs.writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=sk\nCHANNEL_TELEGRAM=tg\nCHANNEL_DISCORD=dc\n",
    );
    const c = loadConfig(envPath);
    expect(c.channels).toEqual(
      expect.arrayContaining([
        { type: "telegram", token: "tg" },
        { type: "discord", token: "dc" },
      ]),
    );
    expect(c.channels).toHaveLength(2);
  });

  it("returns empty channels when no CHANNEL_* exists", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.channels).toEqual([]);
  });

  it("does not throw when no channel tokens present", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    expect(() => loadConfig(envPath)).not.toThrow();
  });

  it("reads optional OPENAI_API_KEY", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\nOPENAI_API_KEY=oai-key\n");
    const c = loadConfig(envPath);
    expect(c.openaiApiKey).toBe("oai-key");
  });

  it("openaiApiKey is undefined when not set", () => {
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=sk\n");
    const c = loadConfig(envPath);
    expect(c.openaiApiKey).toBeUndefined();
  });
});
