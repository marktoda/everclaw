# Test Harness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a three-layer test pyramid (contract, integration, system) that catches regressions in API contracts, data flow, and task execution.

**Architecture:** Layer 1 uses a FakeAnthropic with contract validation (no Docker). Layer 2 wires real agent loop + executor + Postgres via testcontainers. Layer 3 runs real Absurd workers that claim and execute tasks end-to-end.

**Tech Stack:** vitest, testcontainers (Postgres 17), absurd-sdk, pg

---

### Task 1: Install testcontainers and configure vitest for integration tests

**Files:**
- Modify: `package.json` (add devDependency)
- Create: `vitest.config.ts` (unit tests config)
- Create: `vitest.integration.config.ts` (integration tests config)

**Step 1: Install testcontainers**

Run: `pnpm add -D testcontainers`

**Step 2: Create vitest.config.ts for unit tests**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts", "src/**/*.system.test.ts"],
  },
});
```

**Step 3: Create vitest.integration.config.ts for integration/system tests**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts", "src/**/*.system.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
```

**Step 4: Update package.json scripts**

Add to the `"scripts"` object:

```json
"test:integration": "vitest --run --config vitest.integration.config.ts"
```

**Step 5: Run existing unit tests to verify no regression**

Run: `pnpm test`
Expected: 197 tests pass (the new config file should be picked up and exclude integration files)

**Step 6: Commit**

```
feat: add vitest configs and testcontainers for integration tests
```

---

### Task 2: Build FakeAnthropic with contract validation

**Files:**
- Create: `src/test/fake-anthropic.ts`
- Create: `src/test/fake-anthropic.test.ts`

**Step 1: Write tests for FakeAnthropic**

Create `src/test/fake-anthropic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeAnthropic, type Scenario } from "./fake-anthropic.ts";
import type Anthropic from "@anthropic-ai/sdk";

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

function toolUseBlock(name: string, input: Record<string, unknown>, id: string): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

describe("FakeAnthropic", () => {
  describe("basic operation", () => {
    it("returns scripted responses in order", async () => {
      const scenario: Scenario = {
        name: "simple",
        turns: [{ content: [textBlock("Hello!")], stop_reason: "end_turn" }],
      };
      const fake = new FakeAnthropic(scenario);
      const resp = await fake.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: "system prompt",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      });
      expect(resp.content).toEqual([textBlock("Hello!")]);
      expect(resp.stop_reason).toBe("end_turn");
    });

    it("tracks call count", async () => {
      const scenario: Scenario = {
        name: "two-turn",
        turns: [
          { content: [toolUseBlock("read_file", {}, "t1")], stop_reason: "tool_use" },
          { content: [textBlock("done")], stop_reason: "end_turn" },
        ],
      };
      const fake = new FakeAnthropic(scenario);
      await fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [{ role: "user", content: "hi" }], tools: [],
      });
      expect(fake.callCount).toBe(1);
      await fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [toolUseBlock("read_file", {}, "t1")] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ],
        tools: [],
      });
      expect(fake.callCount).toBe(2);
    });

    it("throws if more calls than turns", async () => {
      const scenario: Scenario = {
        name: "one-turn",
        turns: [{ content: [textBlock("only")], stop_reason: "end_turn" }],
      };
      const fake = new FakeAnthropic(scenario);
      await fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [{ role: "user", content: "hi" }], tools: [],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [{ role: "user", content: "hi" }], tools: [],
      })).rejects.toThrow(/exhausted/i);
    });

    it("assertAllTurnsConsumed passes when all used", async () => {
      const scenario: Scenario = {
        name: "one",
        turns: [{ content: [textBlock("hi")], stop_reason: "end_turn" }],
      };
      const fake = new FakeAnthropic(scenario);
      await fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [{ role: "user", content: "hi" }], tools: [],
      });
      expect(() => fake.assertAllTurnsConsumed()).not.toThrow();
    });

    it("assertAllTurnsConsumed throws when turns remain", () => {
      const scenario: Scenario = {
        name: "two",
        turns: [
          { content: [textBlock("a")], stop_reason: "end_turn" },
          { content: [textBlock("b")], stop_reason: "end_turn" },
        ],
      };
      const fake = new FakeAnthropic(scenario);
      expect(() => fake.assertAllTurnsConsumed()).toThrow(/unconsumed/i);
    });
  });

  describe("contract validation", () => {
    it("rejects missing model", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "", max_tokens: 1, system: "s",
        messages: [{ role: "user", content: "hi" }], tools: [],
      } as any)).rejects.toThrow(/model/i);
    });

    it("rejects missing max_tokens", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 0, system: "s",
        messages: [{ role: "user", content: "hi" }], tools: [],
      } as any)).rejects.toThrow(/max_tokens/i);
    });

    it("rejects empty messages array", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 1, system: "s", messages: [], tools: [],
      } as any)).rejects.toThrow(/messages/i);
    });

    it("rejects messages not starting with user", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [{ role: "assistant", content: "hi" }], tools: [],
      } as any)).rejects.toThrow(/first message.*user/i);
    });

    it("rejects consecutive same-role messages", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
        tools: [],
      } as any)).rejects.toThrow(/alternat/i);
    });

    it("rejects tool_result without preceding tool_use", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [textBlock("thinking")] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
        ],
        tools: [],
      } as any)).rejects.toThrow(/tool_result.*tool_use/i);
    });

    it("rejects orphan tool_use without following tool_result", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [toolUseBlock("read_file", {}, "t1")] },
          { role: "user", content: "what happened?" },
        ],
        tools: [],
      } as any)).rejects.toThrow(/tool_use.*tool_result/i);
    });

    it("rejects mismatched tool_use/tool_result IDs", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await expect(fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [toolUseBlock("read_file", {}, "t1")] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t999", content: "x" }] },
        ],
        tools: [],
      } as any)).rejects.toThrow(/mismatch|missing/i);
    });

    it("accepts valid tool_use → tool_result sequence", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      // Should not throw
      await fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [toolUseBlock("read_file", {}, "t1")] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] },
        ],
        tools: [],
      });
    });

    it("accepts multiple tool_use + tool_result pairs", async () => {
      const fake = new FakeAnthropic({
        name: "t", turns: [{ content: [textBlock("x")], stop_reason: "end_turn" }],
      });
      await fake.messages.create({
        model: "m", max_tokens: 1, system: "s",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [
            toolUseBlock("read_file", {}, "t1"),
            toolUseBlock("get_state", {}, "t2"),
          ]},
          { role: "user", content: [
            { type: "tool_result", tool_use_id: "t1", content: "a" },
            { type: "tool_result", tool_use_id: "t2", content: "b" },
          ]},
        ],
        tools: [],
      });
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/test/fake-anthropic.test.ts`
Expected: FAIL — module not found

**Step 3: Implement FakeAnthropic**

Create `src/test/fake-anthropic.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";

export interface ScenarioTurn {
  content: Anthropic.ContentBlock[];
  stop_reason: "end_turn" | "tool_use";
}

export interface Scenario {
  name: string;
  turns: ScenarioTurn[];
}

export class FakeAnthropic {
  private scenario: Scenario;
  private turnIndex = 0;
  private requests: any[] = [];

  constructor(scenario: Scenario) {
    this.scenario = scenario;
  }

  get callCount(): number {
    return this.requests.length;
  }

  get allRequests(): any[] {
    return this.requests;
  }

  assertAllTurnsConsumed(): void {
    if (this.turnIndex < this.scenario.turns.length) {
      throw new Error(
        `Scenario "${this.scenario.name}" has ${this.scenario.turns.length - this.turnIndex} unconsumed turns ` +
        `(used ${this.turnIndex} of ${this.scenario.turns.length})`
      );
    }
  }

  messages = {
    create: async (params: any): Promise<any> => {
      this.validateRequest(params);
      this.requests.push(structuredClone(params));

      if (this.turnIndex >= this.scenario.turns.length) {
        throw new Error(
          `Scenario "${this.scenario.name}" exhausted: only ${this.scenario.turns.length} turns defined ` +
          `but got call #${this.turnIndex + 1}`
        );
      }

      const turn = this.scenario.turns[this.turnIndex++];
      return { content: turn.content, stop_reason: turn.stop_reason };
    },
  };

  private validateRequest(params: any): void {
    // Required fields
    if (!params.model) throw new Error("Contract violation: model is required");
    if (!params.max_tokens) throw new Error("Contract violation: max_tokens must be > 0");

    const messages: Anthropic.MessageParam[] = params.messages;
    if (!messages || messages.length === 0) {
      throw new Error("Contract violation: messages array must not be empty");
    }

    // First message must be user
    if (messages[0].role !== "user") {
      throw new Error(
        `Contract violation: first message must be role="user", got "${messages[0].role}"`
      );
    }

    // Walk messages: validate alternation and tool_use/tool_result pairing
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const prev = i > 0 ? messages[i - 1] : null;

      // Alternation check
      if (prev && msg.role === prev.role) {
        throw new Error(
          `Contract violation: messages must alternate roles. ` +
          `Found consecutive "${msg.role}" at index ${i - 1} and ${i}`
        );
      }

      // If previous was assistant with tool_use, this must be user with tool_result
      if (prev?.role === "assistant" && Array.isArray(prev.content)) {
        const toolUseBlocks = (prev.content as any[]).filter((b: any) => b.type === "tool_use");
        if (toolUseBlocks.length > 0) {
          // Current message must be user with tool_result blocks
          if (msg.role !== "user" || !Array.isArray(msg.content)) {
            throw new Error(
              `Contract violation: assistant at index ${i - 1} has tool_use blocks ` +
              `but next message at index ${i} is not a user message with tool_result blocks`
            );
          }
          const results = (msg.content as any[]).filter((b: any) => b.type === "tool_result");
          const toolUseIds = new Set(toolUseBlocks.map((b: any) => b.id));
          const resultIds = new Set(results.map((b: any) => b.tool_use_id));
          for (const id of toolUseIds) {
            if (!resultIds.has(id)) {
              throw new Error(
                `Contract violation: tool_use id="${id}" at index ${i - 1} ` +
                `has no matching tool_result at index ${i}`
              );
            }
          }
        }
      }

      // If current is user with tool_result, previous must be assistant with tool_use
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const results = (msg.content as any[]).filter((b: any) => b.type === "tool_result");
        if (results.length > 0 && prev) {
          const prevToolUseIds = new Set(
            Array.isArray(prev.content)
              ? (prev.content as any[]).filter((b: any) => b.type === "tool_use").map((b: any) => b.id)
              : []
          );
          for (const r of results) {
            if (!prevToolUseIds.has(r.tool_use_id)) {
              throw new Error(
                `Contract violation: tool_result with tool_use_id="${r.tool_use_id}" at index ${i} ` +
                `has no matching tool_use in the preceding assistant message. ` +
                `Available IDs: [${[...prevToolUseIds].join(", ")}]`
              );
            }
          }
        }
      }
    }
  }
}
```

**Step 4: Run tests**

Run: `pnpm test src/test/fake-anthropic.test.ts`
Expected: All pass

**Step 5: Commit**

```
feat: add FakeAnthropic with contract validation
```

---

### Task 3: Build reusable test scenarios

**Files:**
- Create: `src/test/scenarios.ts`

**Step 1: Create scenarios file**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Scenario } from "./fake-anthropic.ts";

function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null };
}

function toolUse(name: string, input: Record<string, unknown>, id: string): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

export const SIMPLE_TEXT_REPLY: Scenario = {
  name: "simple-text-reply",
  turns: [{ content: [text("Hello!")], stop_reason: "end_turn" }],
};

export const SINGLE_TOOL_USE: Scenario = {
  name: "single-tool-use",
  turns: [
    { content: [toolUse("read_file", { path: "data/notes/test.md" }, "tu-1")], stop_reason: "tool_use" },
    { content: [text("I read the file.")], stop_reason: "end_turn" },
  ],
};

export const MULTI_TOOL_PARALLEL: Scenario = {
  name: "multi-tool-parallel",
  turns: [
    {
      content: [
        toolUse("read_file", { path: "data/notes/a.md" }, "tu-1"),
        toolUse("get_state", { namespace: "test", key: "k" }, "tu-2"),
      ],
      stop_reason: "tool_use",
    },
    { content: [text("Both done.")], stop_reason: "end_turn" },
  ],
};

export const MULTI_TURN_TOOLS: Scenario = {
  name: "multi-turn-tools",
  turns: [
    { content: [toolUse("read_file", { path: "data/notes/a.md" }, "tu-1")], stop_reason: "tool_use" },
    { content: [toolUse("write_file", { path: "data/notes/b.md", content: "new" }, "tu-2")], stop_reason: "tool_use" },
    { content: [text("Read and wrote files.")], stop_reason: "end_turn" },
  ],
};

export const TEXT_PLUS_TOOL: Scenario = {
  name: "text-plus-tool",
  turns: [
    {
      content: [text("Let me check..."), toolUse("get_state", { namespace: "test", key: "k" }, "tu-1")],
      stop_reason: "tool_use",
    },
    { content: [text("Found it.")], stop_reason: "end_turn" },
  ],
};

export function makeMaxTurnsScenario(): Scenario {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    content: [toolUse("get_state", { namespace: "test", key: "k" }, `tu-${i}`)],
    stop_reason: "tool_use" as const,
  }));
  return { name: "max-turns-exhaustion", turns };
}

export const SUSPENDING_TOOL: Scenario = {
  name: "suspending-tool",
  turns: [
    { content: [toolUse("sleep_for", { step_name: "wait-1", seconds: 0 }, "tu-1")], stop_reason: "tool_use" },
    { content: [text("Woke up!")], stop_reason: "end_turn" },
  ],
};

export const WRITE_AND_READ: Scenario = {
  name: "write-and-read",
  turns: [
    { content: [toolUse("write_file", { path: "data/notes/test.md", content: "hello world" }, "tu-1")], stop_reason: "tool_use" },
    { content: [toolUse("read_file", { path: "data/notes/test.md" }, "tu-2")], stop_reason: "tool_use" },
    { content: [text("File contains: hello world")], stop_reason: "end_turn" },
  ],
};

export const STATE_ROUNDTRIP: Scenario = {
  name: "state-roundtrip",
  turns: [
    { content: [toolUse("set_state", { namespace: "test", key: "color", value: "blue" }, "tu-1")], stop_reason: "tool_use" },
    { content: [toolUse("get_state", { namespace: "test", key: "color" }, "tu-2")], stop_reason: "tool_use" },
    { content: [text("Your color is blue.")], stop_reason: "end_turn" },
  ],
};
```

**Step 2: Verify import works**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```
feat: add reusable test scenarios for FakeAnthropic
```

---

### Task 4: Build the Testcontainers harness

**Files:**
- Create: `src/test/harness.ts`
- Create: `src/test/harness.test.ts`

**Step 1: Write a smoke test for the harness**

Create `src/test/harness.test.ts` — this is an integration test that verifies the harness itself works:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, type TestDb } from "./harness.ts";

describe("test harness", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.teardown();
  });

  it("creates assistant.messages table", async () => {
    const result = await db.pool.query(
      `SELECT COUNT(*) FROM information_schema.tables
       WHERE table_schema = 'assistant' AND table_name = 'messages'`
    );
    expect(parseInt(result.rows[0].count)).toBe(1);
  });

  it("creates assistant.state table", async () => {
    const result = await db.pool.query(
      `SELECT COUNT(*) FROM information_schema.tables
       WHERE table_schema = 'assistant' AND table_name = 'state'`
    );
    expect(parseInt(result.rows[0].count)).toBe(1);
  });

  it("creates absurd queue", async () => {
    const queues = await db.absurd.listQueues();
    expect(queues).toContain("test");
  });

  it("can insert and query messages", async () => {
    await db.pool.query(
      `INSERT INTO assistant.messages (chat_id, role, content) VALUES ($1, $2, $3)`,
      [999, "user", "hello"]
    );
    const result = await db.pool.query(
      `SELECT content FROM assistant.messages WHERE chat_id = $1`,
      [999]
    );
    expect(result.rows[0].content).toBe("hello");
  });

  it("can spawn and list tasks via absurd", async () => {
    db.absurd.registerTask({ name: "test-task" }, async () => ({ ok: true }));
    const { taskID } = await db.absurd.spawn("test-task", { x: 1 });
    expect(taskID).toBeTruthy();
  });
});
```

**Step 2: Implement the harness**

Create `src/test/harness.ts`:

```ts
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import * as pg from "pg";
import * as fs from "fs";
import * as path from "path";
import { Absurd } from "absurd-sdk";

export interface TestDb {
  pool: pg.Pool;
  absurd: Absurd;
  container: StartedTestContainer;
  teardown: () => Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  const container = await new GenericContainer("postgres:17")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "test",
    })
    .withExposedPorts(5432)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://test:test@${host}:${port}/test`;

  const pool = new pg.Pool({ connectionString });

  // Run migrations
  const sqlDir = path.resolve(import.meta.dirname, "../../sql");
  const migration1 = fs.readFileSync(path.join(sqlDir, "001-absurd.sql"), "utf-8");
  const migration2 = fs.readFileSync(path.join(sqlDir, "002-assistant.sql"), "utf-8");
  await pool.query(migration1);
  await pool.query(migration2);

  // Create Absurd instance and queue
  const absurd = new Absurd({ db: pool, queueName: "test" });
  await absurd.createQueue();

  const teardown = async () => {
    await absurd.close();
    await pool.end();
    await container.stop();
  };

  return { pool, absurd, container, teardown };
}
```

**Step 3: Run the harness smoke test**

Run: `pnpm test:integration src/test/harness.test.ts`
Expected: All pass (requires Docker running)

**Step 4: Commit**

```
feat: add testcontainers harness for integration tests
```

---

### Task 5: Layer 1 — Contract tests

**Files:**
- Create: `src/agent/contract.test.ts`

These are fast unit tests (no Docker) that verify the agent loop always produces valid Anthropic API messages, using FakeAnthropic as the validator.

**Step 1: Write contract tests**

Create `src/agent/contract.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { AgentDeps } from "./loop.ts";
import { FakeAnthropic, type Scenario } from "../test/fake-anthropic.ts";
import {
  SIMPLE_TEXT_REPLY,
  SINGLE_TOOL_USE,
  MULTI_TOOL_PARALLEL,
  MULTI_TURN_TOOLS,
  TEXT_PLUS_TOOL,
  makeMaxTurnsScenario,
} from "../test/scenarios.ts";

// Mock only external I/O — keep the real agent loop logic
vi.mock("../memory/history.ts", () => ({
  getRecentMessages: vi.fn().mockResolvedValue([]),
  appendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../skills/manager.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));

vi.mock("../scripts/runner.ts", () => ({
  listTools: vi.fn().mockResolvedValue([]),
}));

vi.mock("fs/promises", () => ({
  readdir: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockResolvedValue(""),
}));

import { runAgentLoop } from "./loop.ts";
import { getRecentMessages } from "../memory/history.ts";

function createMockCtx(): TaskContext {
  return { step: vi.fn(async (_name: string, fn: () => Promise<any>) => fn()) } as any;
}

function createMockPool(): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

function makeDeps(fake: FakeAnthropic, overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    anthropic: fake as any,
    pool: createMockPool(),
    model: "claude-sonnet-4-20250514",
    notesDir: "/tmp/notes",
    skillsDir: "/tmp/skills",
    toolsDir: "/tmp/tools",
    maxHistory: 50,
    tools: [],
    executeTool: vi.fn().mockResolvedValue("tool-result"),
    ...overrides,
  };
}

describe("API contract validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("simple text reply produces valid API calls", async () => {
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "hi", deps);
    fake.assertAllTurnsConsumed();
    // FakeAnthropic would have thrown on any contract violation
  });

  it("single tool use produces valid tool_result pairing", async () => {
    const fake = new FakeAnthropic(SINGLE_TOOL_USE);
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "read notes", deps);
    fake.assertAllTurnsConsumed();
  });

  it("parallel tool calls produce valid multi-result pairing", async () => {
    const fake = new FakeAnthropic(MULTI_TOOL_PARALLEL);
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "do both", deps);
    fake.assertAllTurnsConsumed();
  });

  it("multi-turn tool use maintains valid message sequence", async () => {
    const fake = new FakeAnthropic(MULTI_TURN_TOOLS);
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "read and write", deps);
    fake.assertAllTurnsConsumed();
  });

  it("text + tool_use in same response produces valid sequence", async () => {
    const fake = new FakeAnthropic(TEXT_PLUS_TOOL);
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "check state", deps);
    fake.assertAllTurnsConsumed();
  });

  it("max turns exhaustion produces valid calls for all 20 turns", async () => {
    const fake = new FakeAnthropic(makeMaxTurnsScenario());
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "infinite", deps);
    expect(fake.callCount).toBe(20);
    fake.assertAllTurnsConsumed();
  });

  it("reconstructed history with tool_use/tool_result is API-valid", async () => {
    // Simulate history that has a complete tool use cycle
    vi.mocked(getRecentMessages).mockResolvedValueOnce([
      { chatId: 1, role: "user", content: "read notes" },
      {
        chatId: 1, role: "assistant", content: "(tool use only)",
        toolUse: [{ id: "old-1", name: "read_file", input: { path: "data/notes/a.md" } }],
      },
      {
        chatId: 1, role: "tool", content: "[old-1]: file content",
        toolUse: [{ tool_use_id: "old-1", content: "file content" }],
      },
      { chatId: 1, role: "assistant", content: "Here is the file." },
    ] as any);

    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "follow up", deps);
    // If FakeAnthropic didn't throw, the reconstructed history + new message was valid
  });

  it("orphaned tool_result at start of history is cleaned up", async () => {
    // History window starts mid-conversation with a tool_result (no preceding tool_use)
    vi.mocked(getRecentMessages).mockResolvedValueOnce([
      {
        chatId: 1, role: "tool", content: "[old-1]: result",
        toolUse: [{ tool_use_id: "old-1", content: "result" }],
      },
      { chatId: 1, role: "assistant", content: "Got it" },
      { chatId: 1, role: "user", content: "thanks" },
      { chatId: 1, role: "assistant", content: "Welcome!" },
    ] as any);

    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = makeDeps(fake);
    await runAgentLoop(createMockCtx(), 1, "new message", deps);
    // FakeAnthropic validates the cleaned-up message array
  });
});
```

**Step 2: Run contract tests**

Run: `pnpm test src/agent/contract.test.ts`
Expected: All pass

**Step 3: Commit**

```
test: add Layer 1 contract tests with FakeAnthropic validation
```

---

### Task 6: Layer 2 — Integration tests

**Files:**
- Create: `src/agent/loop.integration.test.ts`

These wire real Postgres + real executor + real file I/O (temp dirs) + FakeAnthropic. Only Claude is faked.

**Step 1: Write integration tests**

Create `src/agent/loop.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setupTestDb, type TestDb } from "../test/harness.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import {
  SIMPLE_TEXT_REPLY,
  SINGLE_TOOL_USE,
  WRITE_AND_READ,
  STATE_ROUNDTRIP,
} from "../test/scenarios.ts";
import { runAgentLoop, type AgentDeps } from "./loop.ts";
import { getTools } from "./tools.ts";
import { createExecutor } from "./executor.ts";
import { getRecentMessages } from "../memory/history.ts";
import type { TaskContext } from "absurd-sdk";

let db: TestDb;

beforeAll(async () => {
  db = await setupTestDb();
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

function makeCtx(): TaskContext {
  // A thin fake ctx that runs steps immediately (no real checkpointing)
  // but sufficient for integration testing the data flow
  return {
    step: async (_name: string, fn: () => Promise<any>) => fn(),
    sleepFor: async () => {},
    sleepUntil: async () => {},
    awaitEvent: async () => null,
    emitEvent: async () => {},
  } as any;
}

describe("integration: agent loop with real Postgres", () => {
  let tmpDir: string;
  let notesDir: string;
  let skillsDir: string;
  let toolsDir: string;
  let chatIdCounter: number;

  beforeAll(() => {
    chatIdCounter = 1000;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "everclaw-test-"));
    notesDir = path.join(tmpDir, "notes");
    skillsDir = path.join(tmpDir, "skills");
    toolsDir = path.join(tmpDir, "tools");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(toolsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function nextChatId(): number {
    return chatIdCounter++;
  }

  function makeDeps(fake: FakeAnthropic): { deps: AgentDeps; ctx: TaskContext } {
    const ctx = makeCtx();
    const executor = createExecutor({
      absurd: db.absurd,
      pool: db.pool,
      ctx,
      queueName: "test",
      chatId: 0, // overridden per call
      notesDir,
      skillsDir,
      toolsDir,
      scriptTimeout: 5,
      startedAt: new Date(),
    });
    const deps: AgentDeps = {
      anthropic: fake as any,
      pool: db.pool,
      model: "claude-sonnet-4-20250514",
      notesDir,
      skillsDir,
      toolsDir,
      maxHistory: 50,
      tools: getTools(),
      executeTool: executor,
    };
    return { deps, ctx };
  }

  it("persists and retrieves conversation history through real Postgres", async () => {
    const chatId = nextChatId();
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const { deps, ctx } = makeDeps(fake);

    await runAgentLoop(ctx, chatId, "hello world", deps);

    const history = await getRecentMessages(db.pool, chatId, 10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]).toMatchObject({ role: "user", content: "hello world" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "Hello!" });
  });

  it("tool execution with real files: write → read → verify", async () => {
    const chatId = nextChatId();
    const fake = new FakeAnthropic(WRITE_AND_READ);
    const { deps, ctx } = makeDeps(fake);

    const result = await runAgentLoop(ctx, chatId, "write and read a file", deps);

    // Verify the file was actually created on disk
    const filePath = path.join(notesDir, "test.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");

    expect(result).toContain("hello world");
    fake.assertAllTurnsConsumed();
  });

  it("state persistence through real Postgres: set → get", async () => {
    const chatId = nextChatId();
    const fake = new FakeAnthropic(STATE_ROUNDTRIP);
    const { deps, ctx } = makeDeps(fake);

    await runAgentLoop(ctx, chatId, "remember my color", deps);

    // Verify state was actually written to Postgres
    const result = await db.pool.query(
      `SELECT value FROM assistant.state WHERE namespace = $1 AND key = $2`,
      ["test", "color"]
    );
    expect(result.rows[0].value).toBe("blue");
    fake.assertAllTurnsConsumed();
  });

  it("history reconstruction fidelity across two messages", async () => {
    const chatId = nextChatId();

    // First message: triggers a tool use
    const fake1 = new FakeAnthropic(SINGLE_TOOL_USE);
    const { deps: deps1, ctx: ctx1 } = makeDeps(fake1);
    // Write a file so read_file succeeds
    fs.writeFileSync(path.join(notesDir, "test.md"), "note content");

    await runAgentLoop(ctx1, chatId, "read my notes", deps1);
    fake1.assertAllTurnsConsumed();

    // Second message: FakeAnthropic validates the reconstructed history is API-valid
    const fake2 = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const { deps: deps2, ctx: ctx2 } = makeDeps(fake2);

    await runAgentLoop(ctx2, chatId, "what did you find?", deps2);
    // If FakeAnthropic didn't throw, the reconstructed history was valid
    fake2.assertAllTurnsConsumed();

    // Verify full history is stored
    const history = await getRecentMessages(db.pool, chatId, 50);
    expect(history.length).toBeGreaterThanOrEqual(4); // user, assistant+tool, tool_result, assistant, user, assistant
  });

  it("real script execution via temp dir", async () => {
    // Write a real script
    const scriptPath = path.join(toolsDir, "greet.sh");
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "hi from script"', { mode: 0o755 });

    const chatId = nextChatId();
    const fake = new FakeAnthropic({
      name: "script-test",
      turns: [
        {
          content: [{
            type: "tool_use", id: "tu-1", name: "run_script",
            input: { name: "greet", input: {} },
          }],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "Script said hi!", citations: null }], stop_reason: "end_turn" },
      ],
    });

    const { deps, ctx } = makeDeps(fake);
    await runAgentLoop(ctx, chatId, "run greet", deps);
    fake.assertAllTurnsConsumed();
  });
});
```

**Step 2: Run integration tests**

Run: `pnpm test:integration src/agent/loop.integration.test.ts`
Expected: All pass (requires Docker)

**Step 3: Commit**

```
test: add Layer 2 integration tests with real Postgres
```

---

### Task 7: Layer 3 — System tests with real Absurd worker

**Files:**
- Create: `src/tasks/system.test.ts`

These register real task handlers, start a real Absurd worker, spawn tasks, and verify they complete.

**Step 1: Write system tests**

Create `src/tasks/system.test.ts` (note the `.test.ts` extension — this will run under the integration config due to the test content, but we can rename to `.system.test.ts`):

Actually, create `src/tasks/system.integration.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setupTestDb, type TestDb } from "../test/harness.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import { SIMPLE_TEXT_REPLY } from "../test/scenarios.ts";
import { registerHandleMessage } from "./handle-message.ts";
import { registerSendMessage } from "./send-message.ts";
import { registerWorkflow } from "./workflow.ts";
import { registerExecuteSkill } from "./execute-skill.ts";
import { getRecentMessages } from "../memory/history.ts";
import type { Config } from "../config.ts";

let db: TestDb;

beforeAll(async () => {
  db = await setupTestDb();
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe("system: real Absurd worker end-to-end", () => {
  let tmpDir: string;
  let config: Config;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "everclaw-sys-"));
    const notesDir = path.join(tmpDir, "notes");
    const skillsDir = path.join(tmpDir, "skills");
    const toolsDir = path.join(tmpDir, "tools");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(toolsDir, { recursive: true });

    config = {
      telegramToken: "fake",
      anthropicApiKey: "fake",
      databaseUrl: "unused",
      queueName: "test",
      notesDir,
      skillsDir,
      toolsDir,
      model: "claude-sonnet-4-20250514",
      maxHistoryMessages: 50,
      workerConcurrency: 1,
      claimTimeout: 30,
      scriptTimeout: 5,
    };

    sendMessage = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function makeBot() {
    return { api: { sendMessage } } as any;
  }

  it("handle-message: spawn → worker executes → bot sends reply", async () => {
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const bot = makeBot();
    const taskDeps = {
      anthropic: fake as any,
      pool: db.pool,
      bot,
      config,
      startedAt: new Date(),
    };

    registerHandleMessage(db.absurd, taskDeps);

    const { taskID } = await db.absurd.spawn("handle-message", {
      chatId: 5000,
      text: "hello from system test",
    });
    expect(taskID).toBeTruthy();

    // Start worker, let it process the task
    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 10,
    });

    // Wait for task completion (poll for history rows)
    let history: any[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      history = await getRecentMessages(db.pool, 5000, 10);
      if (history.length >= 2) break;
    }

    await worker.close();

    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]).toMatchObject({ role: "user", content: "hello from system test" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "Hello!" });
    expect(sendMessage).toHaveBeenCalledWith(5000, "Hello!");
  });

  it("send-message: spawn → worker sends Telegram message", async () => {
    const bot = makeBot();
    registerSendMessage(db.absurd, bot);

    await db.absurd.spawn("send-message", {
      chatId: 5001,
      text: "notification",
    });

    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 10,
    });

    // Wait for message to be sent
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (sendMessage.mock.calls.length > 0) break;
    }

    await worker.close();

    expect(sendMessage).toHaveBeenCalledWith(5001, "notification");
  });

  it("workflow: spawn with instructions → worker runs agent loop", async () => {
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const bot = makeBot();
    const taskDeps = {
      anthropic: fake as any,
      pool: db.pool,
      bot,
      config,
      startedAt: new Date(),
    };

    registerWorkflow(db.absurd, taskDeps);

    await db.absurd.spawn("workflow", {
      chatId: 5002,
      instructions: "say hello",
    });

    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 10,
    });

    // Wait for completion
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (sendMessage.mock.calls.length > 0) break;
    }

    await worker.close();

    expect(sendMessage).toHaveBeenCalledWith(5002, "Hello!");
  });

  it("execute-skill: write skill → spawn → worker runs skill content", async () => {
    // Write a skill file
    fs.writeFileSync(
      path.join(config.skillsDir, "greet.md"),
      "---\nname: greet\ndescription: Say hello\n---\nSay hello to the user."
    );

    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const bot = makeBot();
    const taskDeps = {
      anthropic: fake as any,
      pool: db.pool,
      bot,
      config,
      startedAt: new Date(),
    };

    registerExecuteSkill(db.absurd, taskDeps);

    await db.absurd.spawn("execute-skill", {
      skillName: "greet",
      chatId: 5003,
    });

    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 10,
    });

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (sendMessage.mock.calls.length > 0) break;
    }

    await worker.close();

    expect(sendMessage).toHaveBeenCalledWith(5003, "Hello!");
    // Verify FakeAnthropic received the skill content
    const req = fake.allRequests[0];
    const userMsg = req.messages[req.messages.length - 1];
    expect(userMsg.content).toContain("Say hello to the user.");
  });
});
```

**Step 2: Run system tests**

Run: `pnpm test:integration src/tasks/system.integration.test.ts`
Expected: All pass (requires Docker)

**Step 3: Commit**

```
test: add Layer 3 system tests with real Absurd worker
```

---

### Task 8: Run all tests, update CI scripts, final commit

**Step 1: Run all unit tests**

Run: `pnpm test`
Expected: 197+ tests pass (existing + new FakeAnthropic + contract tests)

**Step 2: Run all integration tests**

Run: `pnpm test:integration`
Expected: All integration + system tests pass

**Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```
test: complete three-layer test pyramid implementation
```

---

## Summary

| Task | Layer | Files | Est. Tests |
|------|-------|-------|------------|
| 1 | Infra | vitest configs, package.json | 0 |
| 2 | Infra | fake-anthropic.ts + tests | ~12 |
| 3 | Infra | scenarios.ts | 0 |
| 4 | Infra | harness.ts + smoke tests | ~5 |
| 5 | L1 | contract.test.ts | ~8 |
| 6 | L2 | loop.integration.test.ts | ~5 |
| 7 | L3 | system.integration.test.ts | ~4 |
| 8 | All | Final verification | 0 |

Total: ~34 new tests across 3 layers, plus the existing 197 unit tests.
