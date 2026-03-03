import * as fs from "fs";
import * as path from "path";

export interface ChannelConfig {
  type: string;
  token: string;
}

export interface Config {
  channels: ChannelConfig[];
  anthropicApiKey: string;
  braveSearchApiKey?: string;
  databaseUrl: string;
  queueName: string;
  notesDir: string;
  skillsDir: string;
  toolsDir: string;
  model: string;
  maxHistoryMessages: number;
  workerConcurrency: number;
  claimTimeout: number;
  scriptTimeout: number;
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
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
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
    channels: [{ type: "telegram", token: requireSecret("TELEGRAM_BOT_TOKEN") }],
    anthropicApiKey: requireSecret("ANTHROPIC_API_KEY"),
    braveSearchApiKey: secrets["BRAVE_SEARCH_API_KEY"] || undefined,
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://localhost/absurd",
    queueName,
    notesDir: path.resolve(process.env.NOTES_DIR ?? "data/notes"),
    skillsDir: path.resolve(process.env.SKILLS_DIR ?? "skills"),
    toolsDir: path.resolve(process.env.TOOLS_DIR ?? "tools"),
    model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5-20250929",
    maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES ?? "50", 10),
    workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10),
    claimTimeout: parseInt(process.env.CLAIM_TIMEOUT ?? "300", 10),
    scriptTimeout: parseInt(process.env.SCRIPT_TIMEOUT ?? "30", 10),
  };
}
