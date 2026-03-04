// src/tasks/system.integration.test.ts — Layer 3 system tests.
// Registers real task handlers on a real Absurd instance (with Testcontainers Postgres),
// starts a real worker, spawns tasks, and verifies they complete.
// Only mocks: Claude API (FakeAnthropic) and Telegram bot (bot.api.sendMessage).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelRegistry } from "../channels/index.ts";
import type { Config } from "../config.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import type { TestDb } from "../test/harness.ts";
import { setupTestDb } from "../test/harness.ts";
import { SIMPLE_TEXT_REPLY } from "../test/scenarios.ts";
import { registerExecuteSkill } from "./execute-skill.ts";
import type { TaskDeps } from "./handle-message.ts";
import { registerHandleMessage } from "./handle-message.ts";
import { registerSendMessage } from "./send-message.ts";
import { registerWorkflow } from "./workflow.ts";

let db: TestDb;
let tmpDir: string;
let notesDir: string;
let skillsDir: string;
let scriptsDir: string;

// Mutable deps object — task handlers capture by reference, so we can swap
// taskDeps.anthropic before each test.
let taskDeps: TaskDeps;

// Mock channels with a spied sendMessage
const sendMessageSpy = vi.fn().mockResolvedValue(undefined);
const channels = {
  sendMessage: sendMessageSpy,
  resolve: vi.fn(),
  register: vi.fn(),
  startAll: vi.fn(),
  stopAll: vi.fn(),
} as unknown as ChannelRegistry;

beforeAll(async () => {
  db = await setupTestDb();

  // Create isolated temp directories for notes, skills, and tools
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everclaw-system-test-"));
  notesDir = path.join(tmpDir, "notes");
  skillsDir = path.join(tmpDir, "skills");
  scriptsDir = path.join(tmpDir, "scripts");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });

  const config: Config = {
    channels: [{ type: "telegram", token: "fake-token" }],
    anthropicApiKey: "fake-key",
    databaseUrl: "unused",
    queueName: "test",
    notesDir,
    skillsDir,
    scriptsDir,
    model: "fake-model",
    maxHistoryMessages: 50,
    workerConcurrency: 1,
    claimTimeout: 30,
    scriptTimeout: 10,
    scriptEnv: {},
    serversDir: path.join(tmpDir, "servers"),
  };

  taskDeps = {
    anthropic: null as any, // set per test
    pool: db.pool,
    channels,
    config,
    startedAt: new Date(),
  };

  // Register all task handlers ONCE
  registerHandleMessage(db.absurd, taskDeps);
  registerSendMessage(db.absurd, channels);
  registerWorkflow(db.absurd, taskDeps);
  registerExecuteSkill(db.absurd, taskDeps);
}, 60_000);

afterAll(async () => {
  await db?.teardown();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/** Poll until a condition is met, up to ~10 seconds. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const interval = 250;
  const iterations = Math.ceil(timeoutMs / interval);
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (condition()) return;
  }
  throw new Error("waitFor timed out");
}

describe("system integration tests", () => {
  it("send-message: spawn → worker sends Telegram message", async () => {
    sendMessageSpy.mockClear();

    const recipientId = "telegram:100001";
    const text = "Hello from send-message test";

    await db.absurd.spawn("send-message", { recipientId, text });
    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 30,
    });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1);

      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:100001", text);
    } finally {
      await worker.close();
    }
  });

  it("handle-message: spawn → worker executes agent loop → bot sends reply", async () => {
    sendMessageSpy.mockClear();
    taskDeps.anthropic = new FakeAnthropic(SIMPLE_TEXT_REPLY) as any;

    const recipientId = "telegram:100002";
    const text = "Hi there";

    await db.absurd.spawn("handle-message", { recipientId, text });
    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 30,
    });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1);

      // Verify sendMessage was called with "Hello!" (from SIMPLE_TEXT_REPLY scenario)
      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:100002", "Hello!");

      // Verify history rows were persisted
      const result = await db.pool.query(
        `SELECT role, content FROM assistant.messages WHERE chat_id = $1 ORDER BY created_at`,
        ["telegram:100002"],
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
      // First row: user message
      expect(result.rows[0].role).toBe("user");
      expect(result.rows[0].content).toBe(text);
      // Second row: assistant reply
      expect(result.rows[1].role).toBe("assistant");
      expect(result.rows[1].content).toBe("Hello!");
    } finally {
      await worker.close();
    }
  });

  it("workflow: spawn with instructions → worker runs agent loop", async () => {
    sendMessageSpy.mockClear();
    taskDeps.anthropic = new FakeAnthropic(SIMPLE_TEXT_REPLY) as any;

    const recipientId = "telegram:100003";
    const instructions = "Say hello to the user";

    await db.absurd.spawn("workflow", { recipientId, instructions });
    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 30,
    });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1);

      // Verify sendMessage was called with the workflow reply
      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:100003", "Hello!");
    } finally {
      await worker.close();
    }
  });

  it("execute-skill: write skill → spawn → worker runs skill content", async () => {
    sendMessageSpy.mockClear();
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    taskDeps.anthropic = fake as any;

    const recipientId = "telegram:100004";
    const skillName = "test-skill";
    const skillContent = `---
description: A test skill
---

Tell the user good morning.
`;
    // Write the skill file to the temp skills directory
    await fs.writeFile(path.join(skillsDir, `${skillName}.md`), skillContent);

    await db.absurd.spawn("execute-skill", { skillName, recipientId });
    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 30,
    });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1);

      // Verify sendMessage was called
      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:100004", "Hello!");

      // Verify FakeAnthropic received the skill content in the messages
      expect(fake.callCount).toBeGreaterThanOrEqual(1);
      const firstRequest = fake.allRequests[0];
      // The user message should contain the skill content
      const userMessages = firstRequest.messages.filter((m: any) => m.role === "user");
      const lastUserMsg = userMessages[userMessages.length - 1];
      expect(lastUserMsg.content).toContain("Tell the user good morning.");
    } finally {
      await worker.close();
    }
  });
});
