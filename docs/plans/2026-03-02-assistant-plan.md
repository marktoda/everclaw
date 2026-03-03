# Everclaw Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a self-extending AI personal assistant that uses Absurd as its durable workflow backbone, Telegram as the communication channel, Claude as the reasoning engine, and markdown skill files as the extensibility mechanism. Every interaction is a durable workflow. The entire agent runs inside a Docker container.

**Architecture:** Every Telegram message spawns a durable Absurd task. The agent loop runs as checkpointed steps (Claude API calls cached via `ctx.step()`). The agent can extend itself by writing skill files (markdown workflow templates) and tool scripts (executable code) using generic file tools. Durable workflow primitives — sleep, spawn, events — let the agent author long-lived processes that survive restarts. Everything runs inside a Docker container for security.

**Tech Stack:** TypeScript, Absurd SDK (`absurd-sdk`), grammY (Telegram), `@anthropic-ai/sdk` (Claude), vitest (tests)

**Design doc:** `docs/plans/2026-03-02-assistant-design.md`

---

## Phase 1: Project Foundation

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `data/notes/profile.md`
- Create: `sql/001-absurd.sql`
- Create: `sql/002-assistant.sql`
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Step 1: Initialize the repo**

```bash
mkdir everclaw && cd everclaw
git init
mkdir -p src/tasks src/agent src/memory src/skills src/scripts skills tools data/notes sql
```

**Step 2: Create package.json**

Uses pnpm to support installing `absurd-sdk` from a subdirectory of the
GitHub monorepo (`sdks/typescript/` in `marktoda/absurd`).

```json
{
  "name": "everclaw",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "packageManager": "pnpm@10.6.2",
  "scripts": {
    "build": "tsc",
    "dev": "node --experimental-strip-types src/index.ts",
    "test": "vitest --run"
  },
  "dependencies": {
    "absurd-sdk": "github:marktoda/absurd#schedules&path:sdks/typescript",
    "@anthropic-ai/sdk": "^0.39.0",
    "grammy": "^1.35.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.10",
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  }
}
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
.env
```

**Step 5: Create initial agent notes**

`data/notes/profile.md`:

```markdown
# User Profile
- (no information yet)

# Learned Preferences
- (none yet)

# Ongoing Context
- (none yet)
```

**Step 6: Create SQL schemas**

Copy the Absurd SQL schema into the project. The docker-compose init script
mounts `sql/` into `docker-entrypoint-initdb.d/`. Files run alphabetically
on first boot, so Absurd schema initializes before assistant schema.

`sql/001-absurd.sql`: Copy from `/home/toda/dev/misc/absurd/sql/absurd.sql`

`sql/002-assistant.sql`:

```sql
CREATE SCHEMA IF NOT EXISTS assistant;

CREATE TABLE IF NOT EXISTS assistant.messages (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content     TEXT NOT NULL,
  tool_use    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat
  ON assistant.messages(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant.state (
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);
```

**Step 7: Create Dockerfile**

`USER assistant` goes after `pnpm install` to avoid permission issues with
the npm cache. No `--prod` flag — we install all deps for TypeScript
stripping at runtime.

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache curl jq git bash python3
RUN adduser -D assistant
WORKDIR /app
COPY --chown=assistant package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY --chown=assistant . .
USER assistant
VOLUME ["/app/data", "/app/skills", "/app/tools"]
CMD ["node", "--experimental-strip-types", "src/index.ts"]
```

**Step 8: Create docker-compose.yml**

The `.env` file is mounted read-only. The application reads it with a
`readEnvFile()` helper that parses but never sets `process.env`. Tool scripts
cannot access API keys.

```yaml
services:
  assistant:
    build: .
    restart: unless-stopped
    volumes:
      - ./data:/app/data
      - ./skills:/app/skills
      - ./tools:/app/tools
      - ./.env:/app/.env:ro
    environment:
      # Only non-secret config
      - DATABASE_URL=postgresql://postgres:postgres@db/absurd
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./sql:/docker-entrypoint-initdb.d
    environment:
      - POSTGRES_DB=absurd
      - POSTGRES_PASSWORD=postgres
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

**Step 9: Create .env.example**

```
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
ANTHROPIC_API_KEY=sk-ant-your-key
```

**Step 10: Create minimal src/index.ts and verify**

```typescript
console.log("everclaw starting...");
```

```bash
pnpm install
pnpm tsc --noEmit
```

**Step 11: Commit**

```bash
git add -A
git commit -m "feat: scaffold everclaw project"
```

---

### Task 2: Config module

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

Secrets (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`) are loaded from the
mounted `.env` file at startup using a `readEnvFile()` helper — NOT from
`process.env`. This means secrets are only in-memory variables, never set
as environment variables that would be inherited by child processes (tool
scripts).

Non-secret config (DATABASE_URL, paths, timeouts) can come from `process.env`.

**Step 1: Write the test**

```typescript
// src/config.test.ts
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
```

**Step 2: Run test — expected FAIL**

```bash
pnpm vitest run src/config.test.ts
```

**Step 3: Implement**

```typescript
// src/config.ts
import * as fs from "fs";
import * as path from "path";

export interface Config {
  telegramToken: string;
  anthropicApiKey: string;
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

  return {
    telegramToken: requireSecret("TELEGRAM_BOT_TOKEN"),
    anthropicApiKey: requireSecret("ANTHROPIC_API_KEY"),
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://localhost/absurd",
    queueName: process.env.QUEUE_NAME ?? "assistant",
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
```

**Step 4: Run test — expected PASS**

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add config module"
```

---

## Phase 2: Memory Layer

### Task 3: Conversation history + state store

**Files:**
- Create: `src/memory/history.ts`
- Create: `src/memory/state.ts`

No separate notes module — notes are just files in `data/notes/`, managed
by the agent using generic file tools (defined in Task 7).

**Step 1: Implement history**

```typescript
// src/memory/history.ts
import type { Pool } from "pg";

export interface Message {
  id?: number;
  chatId: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolUse?: any;
  createdAt?: Date;
}

export async function appendMessage(pool: Pool, msg: Message): Promise<void> {
  await pool.query(
    `INSERT INTO assistant.messages (chat_id, role, content, tool_use)
     VALUES ($1, $2, $3, $4)`,
    [msg.chatId, msg.role, msg.content, msg.toolUse ? JSON.stringify(msg.toolUse) : null],
  );
}

export async function getRecentMessages(
  pool: Pool, chatId: number, limit: number = 50,
): Promise<Message[]> {
  const result = await pool.query(
    `SELECT id, chat_id, role, content, tool_use, created_at
     FROM assistant.messages WHERE chat_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [chatId, limit],
  );
  return result.rows.reverse().map((r) => ({
    id: r.id, chatId: r.chat_id, role: r.role,
    content: r.content, toolUse: r.tool_use, createdAt: r.created_at,
  }));
}
```

**Step 2: Implement state store**

```typescript
// src/memory/state.ts
import type { Pool } from "pg";

export async function getState(pool: Pool, namespace: string, key: string): Promise<any | null> {
  const r = await pool.query(
    `SELECT value FROM assistant.state WHERE namespace = $1 AND key = $2`,
    [namespace, key],
  );
  return r.rows.length === 0 ? null : r.rows[0].value;
}

export async function setState(pool: Pool, namespace: string, key: string, value: any): Promise<void> {
  await pool.query(
    `INSERT INTO assistant.state (namespace, key, value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (namespace, key) DO UPDATE SET value = $3, updated_at = now()`,
    [namespace, key, JSON.stringify(value)],
  );
}

export async function deleteState(pool: Pool, namespace: string, key: string): Promise<void> {
  await pool.query(
    `DELETE FROM assistant.state WHERE namespace = $1 AND key = $2`,
    [namespace, key],
  );
}

export async function listState(pool: Pool, namespace: string): Promise<Array<{ key: string; value: any }>> {
  const r = await pool.query(
    `SELECT key, value FROM assistant.state WHERE namespace = $1 ORDER BY key`,
    [namespace],
  );
  return r.rows;
}
```

**Step 3: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/memory/history.ts src/memory/state.ts
git commit -m "feat: add conversation history and state store"
```

---

## Phase 3: Skills & Scripts

### Task 4: Skill manager

**Files:**
- Create: `src/skills/manager.ts`
- Test: `src/skills/manager.test.ts`

The skill manager reads and parses skill files, and provides `syncSchedules()`
to reconcile skill-based schedules with Absurd's registry. No CRUD methods —
the agent writes skills using generic file tools, then the executor calls
`syncSchedules()` as a side effect.

**Step 1: Write the test**

```typescript
// src/skills/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listSkills, parseSkillFrontmatter } from "./manager.js";

describe("skill manager", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-")); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it("returns empty list for empty dir", async () => {
    expect(await listSkills(tmpDir)).toEqual([]);
  });

  it("lists .md files as skills", async () => {
    fs.writeFileSync(path.join(tmpDir, "foo.md"), "---\nname: foo\n---\n# Foo");
    fs.writeFileSync(path.join(tmpDir, "bar.md"), "---\nname: bar\n---\n# Bar");
    fs.writeFileSync(path.join(tmpDir, "not-a-skill.txt"), "ignore me");
    const skills = await listSkills(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map(s => s.name).sort()).toEqual(["bar", "foo"]);
  });

  it("parses frontmatter", () => {
    const fm = parseSkillFrontmatter("---\nname: test\ndescription: Desc\nschedule: \"0 9 * * *\"\n---\n# Body");
    expect(fm.name).toBe("test");
    expect(fm.description).toBe("Desc");
    expect(fm.schedule).toBe("0 9 * * *");
  });

  it("handles missing frontmatter", () => {
    const fm = parseSkillFrontmatter("# Just a heading\nSome text");
    expect(fm.name).toBeUndefined();
  });
});
```

**Step 2: Run test — expected FAIL**

**Step 3: Implement**

```typescript
// src/skills/manager.ts
import * as fs from "fs/promises";
import * as path from "path";
import type { Absurd } from "absurd-sdk";

export interface SkillMeta {
  name?: string;
  description?: string;
  schedule?: string;
  [key: string]: string | undefined;
}

export interface SkillSummary {
  name: string;
  description: string;
  schedule?: string;
  filename: string;
}

export function parseSkillFrontmatter(content: string): SkillMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta: SkillMeta = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.substring(0, colon).trim();
    let val = line.substring(colon + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return meta;
}

export async function listSkills(skillsDir: string): Promise<SkillSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(skillsDir, entry), "utf-8");
    const meta = parseSkillFrontmatter(content);
    skills.push({
      name: meta.name ?? entry.replace(/\.md$/, ""),
      description: meta.description ?? "",
      schedule: meta.schedule,
      filename: entry,
    });
  }
  return skills;
}

/**
 * Reconcile skill-based schedules with Absurd's schedule registry.
 * Compares skill files' frontmatter against existing schedules and
 * creates/updates/deletes to match. Called on startup and after any
 * file write or delete in the skills directory.
 */
export async function syncSchedules(
  absurd: Absurd,
  skillsDir: string,
  chatId: number,
): Promise<void> {
  const skills = await listSkills(skillsDir);
  const schedules = await absurd.listSchedules();

  const existing = new Map(
    schedules
      .filter(s => s.scheduleName.startsWith("skill:"))
      .map(s => [s.scheduleName, s]),
  );

  const desired = new Map(
    skills
      .filter(s => s.schedule)
      .map(s => [
        `skill:${s.name}`,
        { skillName: s.name, schedule: s.schedule!, chatId },
      ]),
  );

  // Create or update
  for (const [name, skill] of desired) {
    const curr = existing.get(name);
    if (!curr || curr.scheduleExpr !== skill.schedule) {
      if (curr) {
        try { await absurd.deleteSchedule(name); } catch { /* ok */ }
      }
      await absurd.createSchedule(name, "execute-skill", skill.schedule, {
        params: { skillName: skill.skillName, chatId: skill.chatId },
      });
    }
  }

  // Delete orphans
  for (const [name] of existing) {
    if (!desired.has(name)) {
      try { await absurd.deleteSchedule(name); } catch { /* ok */ }
    }
  }
}
```

**Step 4: Run test — expected PASS**

**Step 5: Commit**

```bash
git add src/skills/manager.ts src/skills/manager.test.ts
git commit -m "feat: add skill manager with frontmatter parsing and schedule sync"
```

---

### Task 5: Script runner

**Files:**
- Create: `src/scripts/runner.ts`
- Test: `src/scripts/runner.test.ts`

Executes tool scripts inside the container with a timeout. Input is JSON
on stdin, output is captured from stdout.

**Step 1: Write the test**

```typescript
// src/scripts/runner.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runScript, listTools } from "./runner.js";

describe("script runner", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-")); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it("executes a bash script with stdin input", async () => {
    const script = path.join(tmpDir, "echo.sh");
    fs.writeFileSync(script, '#!/bin/bash\ncat', { mode: 0o755 });
    const result = await runScript(script, '{"text":"hello"}', 5);
    expect(result).toBe('{"text":"hello"}');
  });

  it("captures stdout", async () => {
    const script = path.join(tmpDir, "greet.sh");
    fs.writeFileSync(script, '#!/bin/bash\necho "hi there"', { mode: 0o755 });
    const result = await runScript(script, "{}", 5);
    expect(result.trim()).toBe("hi there");
  });

  it("throws on timeout", async () => {
    const script = path.join(tmpDir, "slow.sh");
    fs.writeFileSync(script, '#!/bin/bash\nsleep 10', { mode: 0o755 });
    await expect(runScript(script, "{}", 1)).rejects.toThrow();
  });

  it("lists tool scripts", async () => {
    fs.writeFileSync(path.join(tmpDir, "foo.sh"), "#!/bin/bash\n", { mode: 0o755 });
    fs.writeFileSync(path.join(tmpDir, "bar.py"), "#!/usr/bin/env python3\n", { mode: 0o755 });
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "not a tool");
    const tools = await listTools(tmpDir);
    expect(tools).toHaveLength(2);
  });
});
```

**Step 2: Run test — expected FAIL**

**Step 3: Implement**

```typescript
// src/scripts/runner.ts
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".py", ".js", ".ts"]);

export function runScript(
  scriptPath: string,
  input: string,
  timeoutSeconds: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      scriptPath,
      [],
      {
        timeout: timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024, // 1MB
      },
      (err, stdout, stderr) => {
        if (err) {
          if (stderr) reject(new Error(`Script failed: ${stderr}`));
          else reject(err);
          return;
        }
        resolve(stdout);
      },
    );
    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export async function listTools(
  toolsDir: string,
): Promise<Array<{ name: string; path: string }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(toolsDir);
  } catch {
    return [];
  }

  const tools: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    const ext = path.extname(entry);
    if (!SCRIPT_EXTENSIONS.has(ext)) continue;
    tools.push({
      name: entry.replace(/\.[^.]+$/, ""),
      path: path.join(toolsDir, entry),
    });
  }
  return tools;
}
```

**Step 4: Run test — expected PASS**

**Step 5: Commit**

```bash
git add src/scripts/runner.ts src/scripts/runner.test.ts
git commit -m "feat: add script runner with timeout support"
```

---

## Phase 4: Agent Core

### Task 6: Tool definitions

**Files:**
- Create: `src/agent/tools.ts`
- Test: `src/agent/tools.test.ts`

15 tools in 4 categories: files (4), state (3), scripts (1), orchestration (7).

**Step 1: Write the test**

```typescript
// src/agent/tools.test.ts
import { describe, it, expect } from "vitest";
import { getTools } from "./tools.js";

describe("getTools", () => {
  it("returns all 15 tools", () => {
    const tools = getTools();
    expect(tools).toHaveLength(15);
  });

  it("returns file tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("list_files");
    expect(names).toContain("delete_file");
  });

  it("returns state tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("get_state");
    expect(names).toContain("set_state");
    expect(names).toContain("get_status");
  });

  it("returns script tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("run_script");
  });

  it("returns orchestration tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("sleep_for");
    expect(names).toContain("sleep_until");
    expect(names).toContain("spawn_task");
    expect(names).toContain("cancel_task");
    expect(names).toContain("list_tasks");
    expect(names).toContain("wait_for_event");
    expect(names).toContain("emit_event");
  });

  it("each tool has proper schema", () => {
    for (const tool of getTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema.type).toBe("object");
    }
  });
});
```

**Step 2: Run test — expected FAIL**

**Step 3: Implement**

```typescript
// src/agent/tools.ts
import type Anthropic from "@anthropic-ai/sdk";

export type ToolDef = Anthropic.Tool;

export function getTools(): ToolDef[] {
  return [
    // --- File Tools ---
    tool("read_file", "Read a file from a writable directory (data/notes/, skills/, tools/).", {
      path: { type: "string", description: "Relative path within a writable directory (e.g. 'data/notes/profile.md', 'skills/morning-check.md')" },
    }, ["path"]),

    tool("write_file", "Write or overwrite a file. Side effects: writes to skills/ trigger schedule sync, writes to tools/ auto chmod +x.", {
      path: { type: "string", description: "Relative path within a writable directory" },
      content: { type: "string", description: "Full file content" },
    }, ["path", "content"]),

    tool("list_files", "List files in a writable directory.", {
      directory: { type: "string", description: "Directory to list: 'data/notes', 'skills', or 'tools'" },
    }, ["directory"]),

    tool("delete_file", "Delete a file. Side effects: deletes in skills/ trigger schedule sync.", {
      path: { type: "string", description: "Relative path within a writable directory" },
    }, ["path"]),

    // --- State Tools ---
    tool("get_state", "Read a value from the state store.", {
      namespace: { type: "string", description: "Namespace (e.g. 'workflow', 'skill:name')" },
      key: { type: "string", description: "Key" },
    }, ["namespace", "key"]),

    tool("set_state", "Write a value to the state store.", {
      namespace: { type: "string", description: "Namespace" },
      key: { type: "string", description: "Key" },
      value: { description: "JSON value to store" },
    }, ["namespace", "key", "value"]),

    tool("get_status", "Get assistant uptime, file counts, and schedule count.", {}),

    // --- Script Tools ---
    tool("run_script", "Execute a tool script. Input is passed as JSON stdin.", {
      name: { type: "string", description: "Tool script name (without extension)" },
      input: { type: "object", description: "JSON input to pass to the script" },
    }, ["name"]),

    // --- Orchestration Tools ---
    tool("sleep_for", "Suspend this task for a duration. Your worker slot is released; you resume exactly where you left off. Use for polling loops or delayed follow-ups.", {
      step_name: { type: "string", description: "Unique name for this sleep point (e.g. 'check-3'). Must be unique across the task." },
      seconds: { type: "number", description: "Seconds to sleep" },
    }, ["step_name", "seconds"]),

    tool("sleep_until", "Suspend until a specific time. Use for reminders or 'do this tomorrow' patterns.", {
      step_name: { type: "string", description: "Unique name for this sleep point" },
      wake_at: { type: "string", description: "ISO 8601 datetime (e.g. '2024-03-15T17:00:00Z')" },
    }, ["step_name", "wake_at"]),

    tool("spawn_task", "Spawn an independent sub-task that runs in the background. The spawned task has NO access to your current conversation — only the instructions you provide.", {
      task_name: { type: "string", description: "Task type: 'execute-skill', 'send-message', or 'workflow'" },
      params: { type: "object", description: "Task parameters (for 'workflow': {chatId, instructions})" },
    }, ["task_name", "params"]),

    tool("cancel_task", "Cancel a running or sleeping task.", {
      task_id: { type: "string", description: "Task ID to cancel (from list_tasks or spawn_task result)" },
    }, ["task_id"]),

    tool("list_tasks", "List active and sleeping tasks. Use to discover running workflows, check status, or find tasks to cancel.", {}),

    tool("wait_for_event", "Suspend until a named event is emitted by another task. Events are one-shot latches. Use for task-to-task coordination, NOT for waiting on user replies.", {
      event_name: { type: "string", description: "Event name to wait for (e.g. 'done:{taskId}')" },
      timeout_seconds: { type: "number", description: "Optional timeout in seconds" },
    }, ["event_name"]),

    tool("emit_event", "Emit a named event that wakes any tasks waiting on it.", {
      event_name: { type: "string", description: "Event name to emit" },
      payload: { description: "Optional JSON payload delivered to waiters" },
    }, ["event_name"]),
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[] = [],
): ToolDef {
  return {
    name,
    description,
    input_schema: { type: "object" as const, properties, required },
  };
}
```

**Step 4: Run test — expected PASS**

**Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts
git commit -m "feat: add tool definitions (15 tools in 4 categories)"
```

---

### Task 7: Prompt assembly

**Files:**
- Create: `src/agent/prompt.ts`
- Test: `src/agent/prompt.test.ts`

**Step 1: Write the test**

```typescript
// src/agent/prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt.js";

describe("buildSystemPrompt", () => {
  it("includes base instructions", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toContain("personal AI assistant");
  });

  it("includes notes", () => {
    const p = buildSystemPrompt({ notes: "Name: Alice", skills: [], tools: [] });
    expect(p).toContain("Name: Alice");
  });

  it("includes skill summaries", () => {
    const p = buildSystemPrompt({
      notes: "",
      skills: [{ name: "todo", description: "Manage TODOs", schedule: "0 9 * * *" }],
      tools: [],
    });
    expect(p).toContain("todo");
    expect(p).toContain("Manage TODOs");
  });

  it("includes date", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("includes workflow capabilities", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toContain("Workflow Capabilities");
    expect(p).toContain("sleep_for");
    expect(p).toContain("spawn_task");
    expect(p).toContain("pending-action");
  });
});
```

**Step 2: Run test — expected FAIL**

**Step 3: Implement**

```typescript
// src/agent/prompt.ts
export interface PromptContext {
  notes: string;
  skills: Array<{ name: string; description: string; schedule?: string }>;
  tools: Array<{ name: string }>;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  parts.push(`You are a personal AI assistant communicating through Telegram.
You are helpful, concise, and proactive. You can extend your own capabilities
by creating skills (markdown workflow templates) and tool scripts using file tools.

## File Tools

You have generic file tools for all writable directories:
- **data/notes/**: Your persistent notes. Read them at the start of conversations.
  Write here to remember things about the user, preferences, ongoing context.
- **skills/**: Workflow templates. Each .md file with YAML frontmatter defines a
  skill. Include a \`schedule\` field for recurring behaviors (cron expressions).
  Schedules are synced automatically when you write or delete skill files.
- **tools/**: Executable scripts. Write shell/Python scripts here — they're
  auto-marked executable. Run them with run_script.

## Workflow Capabilities

You have durable workflow tools. When you sleep or wait, your worker slot is
released — the server can restart and you'll resume exactly where you left off.

### Timers
- **sleep_for(step_name, seconds)**: Suspend for a duration. Use for polling loops.
- **sleep_until(step_name, wake_at)**: Suspend until a specific time. Use for reminders.
  Each step_name must be unique within a task. Use incrementing suffixes for loops
  (e.g., "check-1", "check-2").

### Background Work
- **spawn_task(task_name, params)**: Start an independent background task. It runs
  with only the instructions you provide — it does not share your conversation context.
  For 'workflow' tasks: params = {chatId, instructions}. For 'send-message':
  params = {chatId, text}.
- **cancel_task(task_id)**: Cancel a running or sleeping task.
- **list_tasks()**: List active and sleeping tasks.

### Task Coordination (advanced)
- **wait_for_event(event_name, timeout?)**: Suspend until a named event fires.
  Events are one-shot latches — once emitted, any future wait returns immediately.
  Best for waiting on a spawned task's completion (e.g., "done:{taskId}").
- **emit_event(event_name, payload?)**: Emit a named event to wake waiting tasks.
  Use task IDs in event names for uniqueness. Record your event conventions in notes.
  For simple coordination, prefer state store + sleep_for polling over events.

### User Interaction
You do NOT have a "wait for reply" tool. When you need user input:
1. Ask your question (send text)
2. Save any context needed to continue via set_state (e.g., set_state("workflow", "pending-action", {...}))
3. Let your task complete
4. The user's reply arrives as a new message — you'll see it in conversation history
   alongside your question, and can read your saved state to continue the workflow.

Always check for pending workflow state at the start of each turn
(get_state("workflow", "pending-action")).

### When to Use What
- **Reminders**: sleep_until, then send message. One task, no state store needed.
- **Polling** (health check, PR status): sleep_for loop within one task.
- **Background work**: spawn_task. User keeps chatting normally.
- **User confirmation**: Ask question, save state, complete. Resume on next message.
- **Recurring tasks**: Write a skill with a schedule field, not sleep loops.

## Scratchpad

You can use <internal>...</internal> tags for scratchpad reasoning that should
not be shown to the user. Everything inside these tags is stripped before
sending. Use this for planning, thinking through tool sequences, or notes
to yourself.

Current date and time: ${new Date().toISOString()}`);

  if (ctx.notes.trim()) {
    parts.push(`## Your Notes\n\n${ctx.notes}`);
  }

  if (ctx.skills.length > 0) {
    const list = ctx.skills.map(s =>
      `- **${s.name}**: ${s.description}${s.schedule ? ` (scheduled: ${s.schedule})` : ""}`
    ).join("\n");
    parts.push(`## Available Skills\n\n${list}`);
  }

  if (ctx.tools.length > 0) {
    const list = ctx.tools.map(t => `- ${t.name}`).join("\n");
    parts.push(`## Available Tool Scripts\n\n${list}`);
  }

  return parts.join("\n\n---\n\n");
}
```

**Step 4: Run test — expected PASS**

**Step 5: Commit**

```bash
git add src/agent/prompt.ts src/agent/prompt.test.ts
git commit -m "feat: add system prompt assembly with workflow capabilities"
```

---

### Task 8: Tool executor

**Files:**
- Create: `src/agent/executor.ts`

Dispatches tool calls to the correct handler. Takes `TaskContext` to support
workflow tools that suspend the task.

**Step 1: Implement**

```typescript
// src/agent/executor.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import { TimeoutError } from "absurd-sdk";
import type { Pool } from "pg";
import { getState, setState } from "../memory/state.js";
import { listSkills, syncSchedules } from "../skills/manager.js";
import { runScript, listTools } from "../scripts/runner.js";
import * as fs from "fs/promises";
import * as path from "path";

export interface ExecutorDeps {
  absurd: Absurd;
  pool: Pool;
  ctx: TaskContext;
  queueName: string;
  chatId: number;
  notesDir: string;
  skillsDir: string;
  toolsDir: string;
  scriptTimeout: number;
  startedAt: Date;
}

/** Writable base directories the agent is allowed to access. */
function resolvePath(input: string, deps: ExecutorDeps): { abs: string; dir: "notes" | "skills" | "tools" } | null {
  // Normalize: strip leading / or ./ if present
  const clean = input.replace(/^\.?\//, "");
  if (clean.startsWith("data/notes/")) {
    return { abs: path.resolve(deps.notesDir, clean.slice("data/notes/".length)), dir: "notes" };
  }
  if (clean.startsWith("skills/")) {
    return { abs: path.resolve(deps.skillsDir, clean.slice("skills/".length)), dir: "skills" };
  }
  if (clean.startsWith("tools/")) {
    return { abs: path.resolve(deps.toolsDir, clean.slice("tools/".length)), dir: "tools" };
  }
  return null;
}

export function createExecutor(deps: ExecutorDeps) {
  return async (name: string, input: Record<string, any>): Promise<string> => {
    switch (name) {
      // --- File Tools ---
      case "read_file": {
        const resolved = resolvePath(input.path, deps);
        if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
        try {
          return await fs.readFile(resolved.abs, "utf-8");
        } catch (err: any) {
          if (err.code === "ENOENT") return "(file not found)";
          throw err;
        }
      }

      case "write_file": {
        const resolved = resolvePath(input.path, deps);
        if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
        await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
        await fs.writeFile(resolved.abs, input.content, "utf-8");
        // Side effects by directory
        if (resolved.dir === "tools") {
          await fs.chmod(resolved.abs, 0o755);
        }
        if (resolved.dir === "skills") {
          await syncSchedules(deps.absurd, deps.skillsDir, deps.chatId);
        }
        return `File written: ${input.path}`;
      }

      case "list_files": {
        const dir = (input.directory as string).replace(/^\.?\//, "");
        let absDir: string;
        if (dir === "data/notes" || dir === "data/notes/") absDir = deps.notesDir;
        else if (dir === "skills" || dir === "skills/") absDir = deps.skillsDir;
        else if (dir === "tools" || dir === "tools/") absDir = deps.toolsDir;
        else return `Error: directory must be data/notes, skills, or tools`;
        try {
          const entries = await fs.readdir(absDir);
          if (entries.length === 0) return "(empty directory)";
          return entries.join("\n");
        } catch {
          return "(directory does not exist)";
        }
      }

      case "delete_file": {
        const resolved = resolvePath(input.path, deps);
        if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
        try {
          await fs.unlink(resolved.abs);
        } catch (err: any) {
          if (err.code === "ENOENT") return "(file not found)";
          throw err;
        }
        if (resolved.dir === "skills") {
          await syncSchedules(deps.absurd, deps.skillsDir, deps.chatId);
        }
        return `File deleted: ${input.path}`;
      }

      // --- State Tools ---
      case "get_state": {
        const val = await getState(deps.pool, input.namespace, input.key);
        return val === null ? "(not set)" : JSON.stringify(val);
      }

      case "set_state":
        await setState(deps.pool, input.namespace, input.key, input.value);
        return "State saved.";

      case "get_status": {
        const uptime = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
        const skills = await listSkills(deps.skillsDir);
        const tools = await listTools(deps.toolsDir);
        const schedules = await deps.absurd.listSchedules();
        return [
          `Uptime: ${uptime}s`,
          `Notes: ${(await fs.readdir(deps.notesDir).catch(() => [])).length} files`,
          `Skills: ${skills.length}`,
          `Tools: ${tools.length}`,
          `Schedules: ${schedules.length}`,
        ].join("\n");
      }

      // --- Script Tools ---
      case "run_script": {
        const tools = await listTools(deps.toolsDir);
        const tool = tools.find(t => t.name === input.name);
        if (!tool) return `Tool "${input.name}" not found. Available: ${tools.map(t => t.name).join(", ")}`;
        return await runScript(tool.path, JSON.stringify(input.input ?? {}), deps.scriptTimeout);
      }

      // --- Orchestration Tools ---
      case "sleep_for":
        await deps.ctx.sleepFor(input.step_name, input.seconds);
        return `Resumed after sleeping ${input.seconds}s.`;

      case "sleep_until": {
        const wakeAt = new Date(input.wake_at);
        await deps.ctx.sleepUntil(input.step_name, wakeAt);
        return `Resumed. It is now ${new Date().toISOString()}.`;
      }

      case "wait_for_event": {
        try {
          const payload = await deps.ctx.awaitEvent(input.event_name, {
            timeout: input.timeout_seconds,
          });
          return JSON.stringify({ received: true, payload });
        } catch (err) {
          if (err instanceof TimeoutError) {
            return JSON.stringify({ received: false, timed_out: true });
          }
          throw err; // SuspendTask and other errors propagate
        }
      }

      case "emit_event":
        await deps.ctx.emitEvent(input.event_name, input.payload ?? null);
        return `Event "${input.event_name}" emitted.`;

      case "spawn_task": {
        const result = await deps.absurd.spawn(input.task_name, input.params);
        return `Task spawned: ${input.task_name} (ID: ${result.taskID})`;
      }

      case "cancel_task":
        await deps.absurd.cancelTask(input.task_id);
        return `Task ${input.task_id} cancelled.`;

      case "list_tasks": {
        const qn = deps.queueName;
        const result = await deps.pool.query(
          `SELECT t.task_id, t.task_name, t.state, r.state as run_state, r.available_at
           FROM absurd.t_${qn} t
           JOIN absurd.r_${qn} r ON r.run_id = t.last_attempt_run
           WHERE t.state IN ('running', 'sleeping', 'pending')
           ORDER BY t.enqueue_at DESC LIMIT 20`
        );
        if (result.rows.length === 0) return "No active tasks.";
        return result.rows.map((r: any) =>
          `- ${r.task_name} (${r.task_id.slice(0, 8)}...) state=${r.run_state}` +
          (r.available_at ? ` wakes=${new Date(r.available_at).toISOString()}` : "")
        ).join("\n");
      }

      default:
        return `Unknown tool: ${name}`;
    }
  };
}
```

**Step 2: Verify compiles**

```bash
pnpm tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/agent/executor.ts
git commit -m "feat: add tool executor with file, state, script, and orchestration handlers"
```

---

### Task 9: Agent loop

**Files:**
- Create: `src/agent/loop.ts`
- Create: `src/agent/output.ts`
- Test: `src/agent/output.test.ts`

The core agent loop: checkpointed Claude API calls with tool dispatch.
Sends text blocks to Telegram per-turn (via an `onText` callback) — not
true token-level streaming, but the user sees each turn's text immediately
rather than waiting for the full tool chain to finish.
Strips `<internal>...</internal>` tags from outbound text.

**Step 1: Implement output filtering**

```typescript
// src/agent/output.ts

/** Strip <internal>...</internal> tags from agent output */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
}
```

**Step 2: Write output tests**

```typescript
// src/agent/output.test.ts
import { describe, it, expect } from "vitest";
import { stripInternalTags } from "./output.js";

describe("stripInternalTags", () => {
  it("removes internal tags", () => {
    expect(stripInternalTags("Hello <internal>thinking...</internal> world"))
      .toBe("Hello  world");
  });

  it("removes multiline internal blocks", () => {
    const input = "Hi\n<internal>\nLet me think\nabout this\n</internal>\nDone";
    expect(stripInternalTags(input)).toBe("Hi\n\nDone");
  });

  it("handles multiple internal blocks", () => {
    expect(stripInternalTags("<internal>a</internal>Hi<internal>b</internal>"))
      .toBe("Hi");
  });

  it("passes through text without internal tags", () => {
    expect(stripInternalTags("Just normal text")).toBe("Just normal text");
  });
});
```

**Step 3: Run test — expected PASS**

**Step 4: Implement agent loop**

```typescript
// src/agent/loop.ts
import Anthropic from "@anthropic-ai/sdk";
import type { TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { ToolDef } from "./tools.js";
import { getRecentMessages, appendMessage } from "../memory/history.js";
import { listSkills } from "../skills/manager.js";
import { listTools } from "../scripts/runner.js";
import { buildSystemPrompt } from "./prompt.js";
import { stripInternalTags } from "./output.js";
import * as fs from "fs/promises";
import * as path from "path";

const MAX_TURNS = 20;

export interface AgentDeps {
  anthropic: Anthropic;
  pool: Pool;
  model: string;
  notesDir: string;
  skillsDir: string;
  toolsDir: string;
  maxHistory: number;
  tools: ToolDef[];
  executeTool: (name: string, input: Record<string, any>) => Promise<string>;
  /** Called with filtered text as it becomes available. */
  onText?: (text: string) => void;
}

/** Read all files in a directory and concatenate their contents. */
async function readAllNotes(notesDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(notesDir);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(notesDir, entry), "utf-8");
    if (content.trim()) parts.push(`### ${entry}\n\n${content}`);
  }
  return parts.join("\n\n");
}

export async function runAgentLoop(
  ctx: TaskContext,
  chatId: number,
  userMessage: string,
  deps: AgentDeps,
): Promise<string> {
  // Load context (checkpointed)
  const context = await ctx.step("load-context", async () => {
    const [notes, history, skills, tools] = await Promise.all([
      readAllNotes(deps.notesDir),
      getRecentMessages(deps.pool, chatId, deps.maxHistory),
      listSkills(deps.skillsDir),
      listTools(deps.toolsDir),
    ]);
    return { notes, history, skills, tools };
  });

  const systemPrompt = buildSystemPrompt({
    notes: context.notes as string,
    skills: (context.skills as any[]).map(s => ({ name: s.name, description: s.description, schedule: s.schedule })),
    tools: (context.tools as any[]).map(t => ({ name: t.name })),
  });

  // Build messages array
  const messages: Anthropic.MessageParam[] = [];
  for (const msg of context.history as any[]) {
    if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: "user", content: userMessage });

  let reply = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await ctx.step(`agent-turn-${turn}`, async () => {
      const r = await deps.anthropic.messages.create({
        model: deps.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: deps.tools,
      });
      return { content: r.content, stopReason: r.stop_reason };
    });

    const content = resp.content as Anthropic.ContentBlock[];
    messages.push({ role: "assistant", content });

    // Send text blocks to the caller per-turn
    const textBlocks = content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    for (const block of textBlocks) {
      const filtered = stripInternalTags(block.text);
      if (filtered && deps.onText) deps.onText(filtered);
    }

    if ((resp.stopReason as string) !== "tool_use") {
      reply = textBlocks.map(b => b.text).join("\n");
      break;
    }

    // Execute tool calls.
    // Workflow tools (sleep_for, sleep_until, wait_for_event) may throw
    // SuspendTask — they must NOT be wrapped in ctx.step() because the
    // step would interfere with the SDK's internal checkpoint management.
    // Non-suspending tools are wrapped in ctx.step() for checkpointing.
    const SUSPENDING_TOOLS = new Set(["sleep_for", "sleep_until", "wait_for_event"]);
    const toolBlocks = content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tb of toolBlocks) {
      let result: string;
      if (SUSPENDING_TOOLS.has(tb.name)) {
        // Call directly — SuspendTask propagates up to the Absurd worker
        result = await deps.executeTool(tb.name, tb.input as Record<string, any>);
      } else {
        result = await ctx.step(`tool-${turn}-${tb.name}`, () =>
          deps.executeTool(tb.name, tb.input as Record<string, any>),
        );
      }
      results.push({ type: "tool_result", tool_use_id: tb.id, content: result as string });
    }
    messages.push({ role: "user", content: results });
  }

  // Persist messages — store the user message, all tool interactions, and
  // the final assistant reply. This ensures the next turn's conversation
  // history includes what tools were used and their results.
  await ctx.step("persist", async () => {
    await appendMessage(deps.pool, { chatId, role: "user", content: userMessage });
    // Walk the messages array to find assistant + tool_result pairs we added
    // during the loop (skip the initial history and the user message we added).
    const loopMessages = messages.slice((context.history as any[]).length + 1);
    for (const msg of loopMessages) {
      if (msg.role === "assistant") {
        // Extract text and tool_use from content blocks
        const blocks = msg.content as Anthropic.ContentBlock[];
        const text = blocks
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map(b => b.text)
          .join("\n");
        const toolUse = blocks
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map(b => ({ name: b.name, input: b.input }));
        await appendMessage(deps.pool, {
          chatId,
          role: "assistant",
          content: text || "(tool use only)",
          toolUse: toolUse.length > 0 ? toolUse : undefined,
        });
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        // Tool results — store as a single tool message with all results
        const toolResults = (msg.content as Anthropic.ToolResultBlockParam[])
          .map(r => `[${r.tool_use_id}]: ${r.content}`)
          .join("\n");
        await appendMessage(deps.pool, {
          chatId,
          role: "tool",
          content: toolResults,
        });
      }
    }
    return true;
  });

  return stripInternalTags(reply);
}
```

**Step 5: Verify compiles**

```bash
pnpm tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/agent/loop.ts src/agent/output.ts src/agent/output.test.ts
git commit -m "feat: add checkpointed agent loop with streaming and internal tag stripping"
```

---

## Phase 5: Tasks, Bot & Entry Point

### Task 10: Absurd tasks

**Files:**
- Create: `src/tasks/handle-message.ts`
- Create: `src/tasks/execute-skill.ts`
- Create: `src/tasks/send-message.ts`
- Create: `src/tasks/workflow.ts`

The executor needs `ctx: TaskContext`, so it must be created inside each
task handler (not shared at startup).

**Step 1: Implement all four tasks**

```typescript
// src/tasks/handle-message.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { Bot } from "grammy";
import { runAgentLoop } from "../agent/loop.js";
import { getTools } from "../agent/tools.js";
import { createExecutor } from "../agent/executor.js";
import type { Config } from "../config.js";

export interface TaskDeps {
  anthropic: Anthropic;
  pool: Pool;
  bot: Bot;
  config: Config;
  startedAt: Date;
}

export function registerHandleMessage(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "handle-message" },
    async (params: { chatId: number; text: string }, ctx: TaskContext) => {
      const executeTool = createExecutor({
        absurd,
        pool: deps.pool,
        ctx,
        queueName: deps.config.queueName,
        chatId: params.chatId,
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        scriptTimeout: deps.config.scriptTimeout,
        startedAt: deps.startedAt,
      });

      const reply = await runAgentLoop(ctx, params.chatId, params.text, {
        anthropic: deps.anthropic,
        pool: deps.pool,
        model: deps.config.model,
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        maxHistory: deps.config.maxHistoryMessages,
        tools: getTools(),
        executeTool,
        onText: (text) => {
          deps.bot.api.sendMessage(params.chatId, text).catch(() => {});
        },
      });

      return { reply };
    },
  );
}
```

```typescript
// src/tasks/execute-skill.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { Bot } from "grammy";
import { runAgentLoop } from "../agent/loop.js";
import { getTools } from "../agent/tools.js";
import { createExecutor } from "../agent/executor.js";
import type { Config } from "../config.js";
import type { TaskDeps } from "./handle-message.js";
import * as fs from "fs/promises";
import * as path from "path";

export function registerExecuteSkill(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "execute-skill" },
    async (params: { skillName: string; chatId: number }, ctx: TaskContext) => {
      const skillContent = await ctx.step("read-skill", async () => {
        return await fs.readFile(
          path.join(deps.config.skillsDir, `${params.skillName}.md`),
          "utf-8",
        );
      });

      const executeTool = createExecutor({
        absurd,
        pool: deps.pool,
        ctx,
        queueName: deps.config.queueName,
        chatId: params.chatId,
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        scriptTimeout: deps.config.scriptTimeout,
        startedAt: deps.startedAt,
      });

      const reply = await runAgentLoop(
        ctx,
        params.chatId,
        `Execute the following skill instructions:\n\n${skillContent}`,
        {
          anthropic: deps.anthropic,
          pool: deps.pool,
          model: deps.config.model,
          notesDir: deps.config.notesDir,
          skillsDir: deps.config.skillsDir,
          toolsDir: deps.config.toolsDir,
          maxHistory: 10,
          tools: getTools(),
          executeTool,
          onText: (text) => {
            deps.bot.api.sendMessage(params.chatId, text).catch(() => {});
          },
        },
      );

      return { skillName: params.skillName, reply };
    },
  );
}
```

```typescript
// src/tasks/send-message.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import type { Bot } from "grammy";

export function registerSendMessage(absurd: Absurd, bot: Bot): void {
  absurd.registerTask(
    { name: "send-message" },
    async (params: { chatId: number; text: string }, _ctx: TaskContext) => {
      await bot.api.sendMessage(params.chatId, params.text);
      return { sent: true };
    },
  );
}
```

```typescript
// src/tasks/workflow.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import { runAgentLoop } from "../agent/loop.js";
import { getTools } from "../agent/tools.js";
import { createExecutor } from "../agent/executor.js";
import type { TaskDeps } from "./handle-message.js";

export function registerWorkflow(absurd: Absurd, deps: TaskDeps): void {
  absurd.registerTask(
    { name: "workflow" },
    async (params: { chatId: number; instructions: string; context?: any }, ctx: TaskContext) => {
      const executeTool = createExecutor({
        absurd,
        pool: deps.pool,
        ctx,
        queueName: deps.config.queueName,
        chatId: params.chatId,
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        scriptTimeout: deps.config.scriptTimeout,
        startedAt: deps.startedAt,
      });

      const contextPrefix = params.context
        ? `Context: ${JSON.stringify(params.context)}\n\n`
        : "";

      const reply = await runAgentLoop(
        ctx,
        params.chatId,
        `${contextPrefix}${params.instructions}`,
        {
          anthropic: deps.anthropic,
          pool: deps.pool,
          model: deps.config.model,
          notesDir: deps.config.notesDir,
          skillsDir: deps.config.skillsDir,
          toolsDir: deps.config.toolsDir,
          maxHistory: 10,
          tools: getTools(),
          executeTool,
          onText: (text) => {
            deps.bot.api.sendMessage(params.chatId, text).catch(() => {});
          },
        },
      );

      return { reply };
    },
  );
}
```

**Step 2: Verify compiles**

```bash
pnpm tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/tasks/
git commit -m "feat: add handle-message, execute-skill, send-message, and workflow tasks"
```

---

### Task 11: Telegram bot

**Files:**
- Create: `src/bot.ts`

**Step 1: Implement**

```typescript
// src/bot.ts
import { Bot } from "grammy";
import type { Absurd } from "absurd-sdk";

export function createBot(token: string, absurd: Absurd): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    await absurd.spawn("handle-message", {
      chatId: ctx.chat.id,
      text: ctx.message.text,
    });
  });

  return bot;
}
```

**Step 2: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add Telegram bot"
```

---

### Task 12: Entry point

**Files:**
- Create: `src/index.ts` (overwrite placeholder)

**Step 1: Implement**

```typescript
// src/index.ts
import * as pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { Absurd } from "absurd-sdk";
import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { registerHandleMessage } from "./tasks/handle-message.js";
import { registerExecuteSkill } from "./tasks/execute-skill.js";
import { registerSendMessage } from "./tasks/send-message.js";
import { registerWorkflow } from "./tasks/workflow.js";
import { syncSchedules } from "./skills/manager.js";
import { getState, setState } from "./memory/state.js";

async function main() {
  const config = loadConfig();
  const startedAt = new Date();

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const absurd = new Absurd({ db: pool, queueName: config.queueName });

  await absurd.createQueue();

  const bot = createBot(config.telegramToken, absurd);

  // Persist defaultChatId via state store. On startup, read it.
  // On first message, write it.
  let defaultChatId = (await getState(pool, "system", "defaultChatId")) ?? 0;
  bot.on("message:text", async (ctx) => {
    if (defaultChatId === 0) {
      defaultChatId = ctx.chat.id;
      await setState(pool, "system", "defaultChatId", defaultChatId);
    }
  });

  const taskDeps = { anthropic, pool, bot, config, startedAt };
  registerHandleMessage(absurd, taskDeps);
  registerExecuteSkill(absurd, taskDeps);
  registerSendMessage(absurd, bot);
  registerWorkflow(absurd, taskDeps);

  // Sync skill schedules on startup
  await syncSchedules(absurd, config.skillsDir, defaultChatId);

  const worker = await absurd.startWorker({
    concurrency: config.workerConcurrency,
    claimTimeout: config.claimTimeout,
    onError: (err) => console.error("[worker]", err.message),
  });

  console.log(`everclaw started (queue=${config.queueName})`);

  bot.start({ onStart: () => console.log("Telegram bot connected") });

  const shutdown = async () => {
    console.log("Shutting down...");
    bot.stop();
    await worker.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
```

**Step 2: Verify compiles**

```bash
pnpm tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point wiring everything together"
```

---

## Phase 6: Smoke Test

### Task 13: End-to-end manual test

**Step 1: Set up**

```bash
cp .env.example .env
# Edit .env with real TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY
```

**Step 2: Start with docker compose**

```bash
docker compose up --build
```

Wait for:
```
everclaw started (queue=assistant)
Telegram bot connected
```

**Step 3: Test basic conversation**

Send to your Telegram bot: "Hello, what can you do?"

Expected: A response describing its capabilities.

**Step 4: Test notes**

Send: "My name is Alice and I'm in the EST timezone"

Then: "What's my name?"

Expected: It should remember "Alice" (check `data/notes/` from host).

**Step 5: Test skill creation**

Send: "Create a skill that sends me a motivational quote every morning at 9am"

Expected: Agent writes `skills/morning-quote.md` via `write_file`.
`syncSchedules()` fires automatically. Verify schedule in Postgres.

**Step 6: Test tool creation**

Send: "Create a tool that checks the weather using curl"

Expected: Agent writes `tools/weather.sh` via `write_file` (auto `chmod +x`).

**Step 7: Test sleep (reminder)**

Send: "Remind me in 30 seconds to test this."

Expected:
- Agent calls `sleep_until` or `sleep_for(30)`
- Task appears as `sleeping` in Postgres: `SELECT * FROM absurd.r_assistant WHERE state = 'sleeping'`
- 30 seconds later, the reminder message arrives

**Step 8: Test confirmation flow**

Send: "Delete all my old log files."

Expected:
- Agent asks "Should I delete them?" and calls `set_state`
- Task completes
- Reply "yes"
- New task reads history + state, proceeds with action
- State is cleared after

**Step 9: Test background spawn**

Send: "Check the health of example.com every minute for 5 minutes and tell me if it goes down. Do this in the background."

Expected:
- Agent calls `spawn_task("workflow", {chatId, instructions: "..."})`
- Current task completes, user can keep chatting
- Background workflow runs independently

**Step 10: Test cancel**

After spawning a background task:
Send: "Cancel that background health check"

Expected: Agent calls `list_tasks` to find it, then `cancel_task`.

---

## Summary

| Phase | Tasks | What you get |
|-------|-------|-------------|
| 1: Foundation | 1-2 | Project scaffold, config, schema, Docker setup |
| 2: Memory | 3 | Conversation history, state store |
| 3: Skills & Scripts | 4-5 | Skill manager with syncSchedules, script runner |
| 4: Agent Core | 6-9 | Tool defs (15 tools), prompt, executor, agent loop |
| 5: Tasks + Bot | 10-12 | Absurd tasks (4 types), Telegram bot, entry point — **MVP works** |
| 6: Smoke Test | 13 | End-to-end verification including workflows |

After Phase 5, you have a fully working self-extending assistant. It can:
- Respond to Telegram messages via Claude with **streaming**
- Remember things about you (notes files managed by generic file tools)
- Create new skills (markdown workflow templates with auto schedule sync)
- Create and run tool scripts (auto `chmod +x`)
- Use `<internal>` tags for private reasoning
- Keep secrets safe (API keys read from file, never in env vars)
- Schedule recurring behaviors via Absurd's cron system
- **Author durable workflows** — sleep, poll, spawn sub-tasks, wait for events
- **Survive restarts** — checkpointed steps resume exactly where they left off
- All running safely inside a Docker container
