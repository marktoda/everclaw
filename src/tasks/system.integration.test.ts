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
import { setupTestDb, waitFor, waitForAsync } from "../test/harness.ts";
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
    agent: {
      model: "fake-model",
      maxHistoryMessages: 50,
    },
    worker: {
      databaseUrl: "unused",
      queueName: "test",
      concurrency: 1,
      claimTimeout: 30,
    },
    dirs: {
      notes: notesDir,
      skills: skillsDir,
      scripts: scriptsDir,
      servers: path.join(tmpDir, "servers"),
      extra: [],
    },
    gmailLabel: "everclaw",
    scriptTimeout: 10,
    scriptEnv: {},
    serverEnv: {},
    allowedChatIds: new Set<string>(),
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

describe("system integration tests", () => {
  it("send-message: spawn → worker sends Telegram message", async () => {
    sendMessageSpy.mockClear();

    const chatId = "telegram:100001";
    const text = "Hello from send-message test";

    await db.absurd.spawn("send-message", { chatId, text });
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

    const chatId = "telegram:100002";
    const text = "Hi there";

    await db.absurd.spawn("handle-message", { chatId, text });
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

  it("workflow: spawn with instructions → worker runs agent loop (silent)", async () => {
    sendMessageSpy.mockClear();
    taskDeps.anthropic = new FakeAnthropic(SIMPLE_TEXT_REPLY) as any;

    const chatId = "telegram:100003";
    const instructions = "Say hello to the user";

    await db.absurd.spawn("workflow", { chatId, instructions });
    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 30,
    });

    try {
      // Workflows run in silent mode — sendMessage is NOT called via onText.
      // Verify the task completes by checking history was persisted.
      await waitForAsync(async () => {
        const result = await db.pool.query(
          `SELECT role FROM assistant.messages WHERE chat_id = $1`,
          [chatId],
        );
        return result.rows.length >= 2;
      });

      // No messages sent via onText (silent mode)
      expect(sendMessageSpy).not.toHaveBeenCalled();
    } finally {
      await worker.close();
    }
  });

  it("execute-skill: write skill → spawn → worker runs skill content (silent)", async () => {
    sendMessageSpy.mockClear();
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    taskDeps.anthropic = fake as any;

    const chatId = "telegram:100004";
    const skillName = "test-skill";
    const skillContent = `---
description: A test skill
---

Tell the user good morning.
`;
    // Write the skill file to the temp skills directory
    await fs.writeFile(path.join(skillsDir, `${skillName}.md`), skillContent);

    await db.absurd.spawn("execute-skill", { skillName, chatId });
    const worker = await db.absurd.startWorker({
      concurrency: 1,
      claimTimeout: 30,
    });

    try {
      // Skills run in silent mode — verify completion via history, not sendMessage.
      await waitForAsync(async () => {
        const result = await db.pool.query(
          `SELECT role FROM assistant.messages WHERE chat_id = $1`,
          [chatId],
        );
        return result.rows.length >= 2;
      });

      // No messages sent via onText (silent mode)
      expect(sendMessageSpy).not.toHaveBeenCalled();

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
