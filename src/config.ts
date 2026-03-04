import * as fs from "node:fs";
import * as path from "node:path";

/** Strip matching surrounding quotes (single or double) from a string. */
export function stripQuotes(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

export interface ChannelConfig {
  type: string;
  token: string;
}

export interface ExtraDir {
  name: string;
  mode: "ro" | "rw";
  absPath: string;
}

export interface Config {
  channels: ChannelConfig[];
  anthropicApiKey: string;
  openaiApiKey?: string;
  braveSearchApiKey?: string;
  databaseUrl: string;
  queueName: string;
  notesDir: string;
  skillsDir: string;
  scriptsDir: string;
  model: string;
  maxHistoryMessages: number;
  workerConcurrency: number;
  claimTimeout: number;
  scriptTimeout: number;
  scriptEnv: Record<string, string>;
  serversDir: string;
  extraDirs: ExtraDir[];
  allowedChatIds: Set<string>;
}

/** Read key=value pairs from a .env file WITHOUT setting process.env */
function readEnvFile(envPath: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.substring(0, eq).trim();
    let val = trimmed.substring(eq + 1).trim();
    val = stripQuotes(val);
    result[key] = val;
  }
  return result;
}

// Must stay in sync with DIR_MAPPINGS prefix roots in agent/tools/files.ts.
const BUILTIN_PREFIXES = ["data", "skills", "scripts", "servers"];

function parseExtraDirs(raw: string | undefined): ExtraDir[] {
  if (!raw?.trim()) return [];
  const dirs: ExtraDir[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 3) {
      throw new Error(`Invalid EXTRA_DIRS entry "${entry}": expected name:mode:path`);
    }
    const name = parts[0];
    const mode = parts[1];
    const absPath = parts.slice(2).join(":");

    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new Error(`Invalid extra dir name "${name}": must match /^[a-z][a-z0-9_-]*$/`);
    }
    if (BUILTIN_PREFIXES.includes(name)) {
      throw new Error(`Extra dir "${name}" conflicts with built-in directory prefix`);
    }
    if (mode !== "ro" && mode !== "rw") {
      throw new Error(`Invalid extra dir "${name}": mode must be "ro" or "rw", got "${mode}"`);
    }
    if (!path.isAbsolute(absPath)) {
      throw new Error(`Invalid extra dir "${name}": path must be absolute, got "${absPath}"`);
    }
    if (seen.has(name)) {
      throw new Error(`Invalid EXTRA_DIRS: duplicate name "${name}"`);
    }
    seen.add(name);
    dirs.push({ name, mode, absPath });
  }
  return dirs;
}

function parseAllowedChatIds(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bare = ids.filter((id) => /^\d+$/.test(id));
  if (bare.length > 0) {
    console.warn(
      `[config] ALLOWED_CHAT_IDS contains bare numeric IDs (${bare.join(", ")}). ` +
      `Use fully prefixed IDs like "telegram:${bare[0]}" instead.`,
    );
  }
  return new Set(ids);
}

function parseChannels(secrets: Record<string, string>): ChannelConfig[] {
  const suffix = "_BOT_TOKEN";
  return Object.entries(secrets)
    .filter(([key]) => key.endsWith(suffix))
    .map(([key, token]) => ({
      type: key.slice(0, -suffix.length).toLowerCase(),
      token,
    }));
}

export function loadConfig(envPath: string = ".env"): Config {
  const secrets = readEnvFile(envPath);

  function requireSecret(name: string): string {
    const val = secrets[name];
    if (!val) throw new Error(`Required secret ${name} not found in ${envPath}`);
    return val;
  }

  const queueName = process.env.QUEUE_NAME ?? "assistant";
  if (!/^[a-z_][a-z0-9_]*$/i.test(queueName)) {
    throw new Error(`Invalid QUEUE_NAME "${queueName}": must be a valid SQL identifier`);
  }

  return {
    channels: parseChannels(secrets),
    anthropicApiKey: requireSecret("ANTHROPIC_API_KEY"),
    openaiApiKey: secrets.OPENAI_API_KEY || undefined,
    braveSearchApiKey: secrets.BRAVE_SEARCH_API_KEY || undefined,
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://localhost/absurd",
    queueName,
    notesDir: path.resolve(process.env.NOTES_DIR ?? "data/notes"),
    skillsDir: path.resolve(process.env.SKILLS_DIR ?? "skills"),
    scriptsDir: path.resolve(process.env.TOOLS_DIR ?? "scripts"),
    model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5-20250929",
    maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES ?? "50", 10),
    workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10),
    claimTimeout: parseInt(process.env.CLAIM_TIMEOUT ?? "300", 10),
    scriptTimeout: parseInt(process.env.SCRIPT_TIMEOUT ?? "30", 10),
    scriptEnv: Object.fromEntries(Object.entries(secrets).filter(([k]) => k.startsWith("TOOL_"))),
    serversDir: path.resolve(process.env.SERVERS_DIR ?? "servers"),
    extraDirs: parseExtraDirs(process.env.EXTRA_DIRS),
    allowedChatIds: parseAllowedChatIds(secrets.ALLOWED_CHAT_IDS),
  };
}
