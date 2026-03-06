// src/agent/loop.integration.test.ts — Layer 2 integration tests.
// Real Postgres (testcontainers) + real executor + real file I/O + FakeAnthropic.
// NO vi.mock() — everything is real except Claude.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRecentMessages } from "../memory/history.ts";
import type { Scenario } from "../test/fake-anthropic.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import type { TestDb } from "../test/harness.ts";
import { setupTestDb } from "../test/harness.ts";
import { SIMPLE_TEXT_REPLY, SINGLE_TOOL_USE, WRITE_AND_READ } from "../test/scenarios.ts";
import type { AgentDeps } from "./loop.ts";
import { runAgentLoop } from "./loop.ts";
import { createToolRegistry } from "./tools/index.ts";

let db: TestDb;

beforeAll(async () => {
  db = await setupTestDb();
}, 60_000);

afterAll(async () => {
  await db?.teardown();
});

// Unique chatId per test to avoid cross-contamination
let chatIdCounter = 1000;

// Temp dirs for notes/skills/tools
let notesDir: string;
let skillsDir: string;
let scriptsDir: string;

beforeEach(() => {
  chatIdCounter += 1;
  notesDir = fs.mkdtempSync(path.join(os.tmpdir(), "everclaw-notes-"));
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "everclaw-skills-"));
  scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "everclaw-scripts-"));
});

afterEach(() => {
  fs.rmSync(notesDir, { recursive: true, force: true });
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

/** Thin fake TaskContext — no real durable execution needed. */
function makeCtx(): any {
  return {
    step: async (_name: string, fn: () => Promise<any>) => fn(),
    sleepFor: async () => {},
    sleepUntil: async () => {},
    awaitEvent: async () => null,
    emitEvent: async () => {},
  };
}

/** Build real AgentDeps wired to real Postgres, real executor, and FakeAnthropic. */
function buildDeps(fake: FakeAnthropic, chatId: string): AgentDeps {
  const ctx = makeCtx();
  const registry = createToolRegistry({
    absurd: db.absurd,
    pool: db.pool,
    ctx,
    queueName: "test",
    chatId,
    dirs: {
      notes: notesDir,
      skills: skillsDir,
      scripts: scriptsDir,
      servers: scriptsDir, // reuse temp dir; servers/ not exercised here
      extra: [],
    },
    scriptTimeout: 10,
    scriptEnv: {},
    startedAt: new Date(),
    allowedChatIds: new Set([chatId]),
  });

  return {
    anthropic: fake as any,
    pool: db.pool,
    model: "fake-model",
    dirs: { notes: notesDir, skills: skillsDir, scripts: scriptsDir },
    maxHistory: 50,
    registry,
  };
}

describe("loop integration tests", () => {
  it("persists and retrieves conversation history through real Postgres", async () => {
    const chatId = `telegram:${chatIdCounter}`;
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = buildDeps(fake, chatId);
    const ctx = makeCtx();

    const reply = await runAgentLoop(ctx, chatId, "Hi there", deps);

    expect(reply).toBe("Hello!");
    fake.assertAllTurnsConsumed();

    // Verify messages persisted in Postgres
    const messages = await getRecentMessages(db.pool, chatId, 50);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hi there");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hello!");
  });

  it("tool execution with real files: write -> read -> verify", async () => {
    const chatId = `telegram:${chatIdCounter}`;
    const fake = new FakeAnthropic(WRITE_AND_READ);
    const deps = buildDeps(fake, chatId);
    const ctx = makeCtx();

    const reply = await runAgentLoop(ctx, chatId, "Write and read a file", deps);

    expect(reply).toBe("File contains: hello world");
    fake.assertAllTurnsConsumed();

    // Verify the file actually exists on disk
    const filePath = path.join(notesDir, "test.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("file round-trip through real file system: write -> read -> verify", async () => {
    const chatId = `telegram:${chatIdCounter}`;
    const fake = new FakeAnthropic(WRITE_AND_READ);
    const deps = buildDeps(fake, chatId);
    const ctx = makeCtx();

    const reply = await runAgentLoop(ctx, chatId, "Write and read a file", deps);

    expect(reply).toBe("File contains: hello world");
    fake.assertAllTurnsConsumed();

    // Verify the file actually exists on disk
    const filePath = path.join(notesDir, "test.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("history reconstruction fidelity across two messages", async () => {
    const chatId = `telegram:${chatIdCounter}`;

    // First: write a file so that SINGLE_TOOL_USE (read_file data/notes/test.md) succeeds
    fs.writeFileSync(path.join(notesDir, "test.md"), "hello from disk");

    // First message: uses SINGLE_TOOL_USE (read_file -> text reply)
    const fake1 = new FakeAnthropic(SINGLE_TOOL_USE);
    const deps1 = buildDeps(fake1, chatId);
    const ctx1 = makeCtx();

    const reply1 = await runAgentLoop(ctx1, chatId, "Read the test file", deps1);
    expect(reply1).toBe("I read the file.");
    fake1.assertAllTurnsConsumed();

    // Second message: uses SIMPLE_TEXT_REPLY — FakeAnthropic validates that
    // the reconstructed history (including tool_use + tool_result from the first
    // message) is valid API format.
    const fake2 = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps2 = buildDeps(fake2, chatId);
    const ctx2 = makeCtx();

    const reply2 = await runAgentLoop(ctx2, chatId, "Thanks!", deps2);
    expect(reply2).toBe("Hello!");
    fake2.assertAllTurnsConsumed();

    // FakeAnthropic validated the request on the second call — if history
    // reconstruction was broken (orphaned tool_result, mismatched IDs, etc.)
    // it would have thrown a contract violation error above.

    // Verify the full history is stored correctly
    const messages = await getRecentMessages(db.pool, chatId, 50);
    // First message: user + assistant(tool_use) + tool(result) + assistant(text)
    // Second message: user + assistant(text)
    // Total: 6 messages
    expect(messages.length).toBe(6);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Read the test file");
    expect(messages[1].role).toBe("assistant");
    const assistantMsg = messages[1] as import("../memory/history.ts").AssistantMessage;
    expect(assistantMsg.toolUse).toBeDefined();
    expect(assistantMsg.toolUse?.length).toBe(1);
    expect(assistantMsg.toolUse?.[0].name).toBe("read_file");
    expect(messages[2].role).toBe("tool");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe("I read the file.");
    expect(messages[4].role).toBe("user");
    expect(messages[4].content).toBe("Thanks!");
    expect(messages[5].role).toBe("assistant");
    expect(messages[5].content).toBe("Hello!");
  });

  it("real script execution via temp dir", async () => {
    const chatId = `telegram:${chatIdCounter}`;

    // Write a bash script to scriptsDir
    const scriptPath = path.join(scriptsDir, "greet.sh");
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "hello from script"', { mode: 0o755 });

    // Custom scenario: call run_script -> text reply
    const scenario: Scenario = {
      name: "run-script",
      turns: [
        {
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "run_script",
              input: { name: "greet", input: {} },
            },
          ],
          stop_reason: "tool_use",
        },
        {
          content: [{ type: "text", text: "Script output received.", citations: null }],
          stop_reason: "end_turn",
        },
      ],
    };

    const fake = new FakeAnthropic(scenario);
    const deps = buildDeps(fake, chatId);
    const ctx = makeCtx();

    const reply = await runAgentLoop(ctx, chatId, "Run the greet script", deps);

    expect(reply).toBe("Script output received.");
    fake.assertAllTurnsConsumed();

    // Verify the script was actually executed by checking the tool result
    // was passed back to the second API call
    const secondRequest = fake.allRequests[1];
    // The user message before the last should contain the tool_result
    const toolResultMsg = secondRequest.messages.find(
      (m: any) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
    const blocks = toolResultMsg!.content as Array<{ type: string; content?: string }>;
    const toolResult = blocks.find((b) => b.type === "tool_result");
    expect(toolResult!.content).toContain("hello from script");
  });
});
