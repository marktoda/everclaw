// src/tasks/durability.integration.test.ts — Durability integration tests.
// Verifies retry-after-failure and checkpoint replay correctness through
// real Absurd + real Postgres (Testcontainers).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelRegistry } from "../channels/index.ts";
import type { Config } from "../config.ts";
import type { Scenario } from "../test/fake-anthropic.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import type { TestDb } from "../test/harness.ts";
import { setupTestDb } from "../test/harness.ts";
import { SIMPLE_TEXT_REPLY } from "../test/scenarios.ts";
import type { TaskDeps } from "./handle-message.ts";
import { registerHandleMessage } from "./handle-message.ts";
import { registerSendMessage } from "./send-message.ts";
import { registerWorkflow } from "./workflow.ts";

let db: TestDb;
let tmpDir: string;

let taskDeps: TaskDeps;

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

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everclaw-durability-test-"));
  const notesDir = path.join(tmpDir, "notes");
  const skillsDir = path.join(tmpDir, "skills");
  const scriptsDir = path.join(tmpDir, "scripts");
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
    scriptTimeout: 10,
    scriptEnv: {},
    serverEnv: {},
    allowedChatIds: new Set<string>(),
  };

  taskDeps = {
    anthropic: null as any,
    pool: db.pool,
    channels,
    config,
    startedAt: new Date(),
  };

  registerHandleMessage(db.absurd, taskDeps);
  registerSendMessage(db.absurd, channels);
  registerWorkflow(db.absurd, taskDeps);
}, 60_000);

afterAll(async () => {
  await db?.teardown();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/** Poll until a sync condition is met. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const interval = 250;
  const iterations = Math.ceil(timeoutMs / interval);
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (condition()) return;
  }
  throw new Error("waitFor timed out");
}

// ── Helpers ─────────────────────────────────────────────────────────

function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null };
}

function toolUse(name: string, input: Record<string, unknown>, id: string): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

/** Extract messages sent to a specific recipient from the spy. */
function sentMessages(recipientId: string): string[] {
  return sendMessageSpy.mock.calls
    .filter((c: any[]) => c[0] === recipientId)
    .map((c: any[]) => c[1] as string);
}

/**
 * A FakeAnthropic that throws on the first N calls, then delegates to a
 * real scenario. Simulates transient API failures (timeout, network error).
 */
class FailThenSucceedAnthropic {
  private callCount = 0;
  private readonly failCount: number;
  private readonly delegate: FakeAnthropic;

  readonly messages: {
    create: (params: any) => Promise<Anthropic.Message>;
  };

  constructor(failCount: number, scenario: Scenario) {
    this.failCount = failCount;
    this.delegate = new FakeAnthropic(scenario);

    this.messages = {
      create: async (params: any): Promise<Anthropic.Message> => {
        this.callCount++;
        if (this.callCount <= this.failCount) {
          throw new Error("Request timed out.");
        }
        return this.delegate.messages.create(params);
      },
    };
  }
}

describe("durability integration tests", () => {
  it("retry after API timeout: task fails then succeeds on retry", async () => {
    sendMessageSpy.mockClear();

    // Fail on first call (attempt 1 crashes), succeed on retry (attempt 2)
    taskDeps.anthropic = new FailThenSucceedAnthropic(1, SIMPLE_TEXT_REPLY) as any;

    const recipientId = "telegram:300001";
    const { taskID } = await db.absurd.spawn(
      "handle-message",
      { recipientId, text: "Hello" },
      { maxAttempts: 3 },
    );
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);

      expect(sendMessageSpy).toHaveBeenCalledWith(recipientId, "Hello!");

      // Verify the task completed on attempt 2 (not attempt 1)
      const result = await db.pool.query(
        `SELECT attempt FROM absurd.r_test
         WHERE task_id = $1 AND state = 'completed'`,
        [taskID],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].attempt).toBe(2);
    } finally {
      await worker.close();
    }
  }, 20_000);

  it("suspend+resume: text and tool results not re-sent or re-executed on replay", async () => {
    sendMessageSpy.mockClear();

    // Scenario: text + write_file → text + sleep_for(1s) → text reply
    //
    // After the sleep suspends and resumes, the Absurd worker replays from
    // checkpoints. This test verifies three things:
    //   1. Text sent before suspend is delivered exactly once (ctx.step('send-text-N') caching)
    //   2. Tool results from before suspend are replayed from checkpoint (not re-executed)
    //   3. The final text after resume is delivered
    const scenario: Scenario = {
      name: "write-sleep-resume",
      turns: [
        {
          content: [
            toolUse(
              "write_file",
              { path: "data/notes/replay-test.md", content: "written once" },
              "tu-1",
            ),
          ],
          stop_reason: "tool_use",
        },
        {
          content: [
            text("File written, now sleeping."),
            toolUse("sleep_for", { step_name: "nap", seconds: 1 }, "tu-2"),
          ],
          stop_reason: "tool_use",
        },
        {
          content: [text("Woke up!")],
          stop_reason: "end_turn",
        },
      ],
    };

    taskDeps.anthropic = new FakeAnthropic(scenario) as any;

    const recipientId = "telegram:300002";
    await db.absurd.spawn("handle-message", { recipientId, text: "Write and sleep" });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => {
        return sentMessages(recipientId).includes("Woke up!");
      }, 20_000);

      const messages = sentMessages(recipientId);

      // Text sent before suspend must appear exactly once — not re-sent on resume.
      // This verifies ctx.step('send-text-1') returns cached result on replay.
      expect(messages.filter((m) => m === "File written, now sleeping.")).toHaveLength(1);
      expect(messages.filter((m) => m === "Woke up!")).toHaveLength(1);

      // File content verifies the write_file tool produced the correct result.
      // (We can't directly prove it wasn't re-executed — the result would be the
      // same either way — but ctx.step('tool-1-tu-1') guarantees idempotency.)
      const filePath = path.join(tmpDir, "notes", "replay-test.md");
      expect(await fs.readFile(filePath, "utf-8")).toBe("written once");
    } finally {
      await worker.close();
    }
  }, 25_000);
});
