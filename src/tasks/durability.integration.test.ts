// src/tasks/durability.integration.test.ts — Durability integration tests.
// Verifies retry-after-failure, checkpoint replay correctness, and
// message-not-re-sent-on-resume through real Absurd + real Postgres.

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

/** Find the first tool_result content in a FakeAnthropic request's messages. */
function findToolResult(request: { messages: any[] }, toolUseId: string): string | undefined {
  for (const msg of request.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
        return block.content;
      }
    }
  }
  return undefined;
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
    await db.absurd.spawn("handle-message", { recipientId, text: "Hello" }, { maxAttempts: 3 });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);

      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:300001", "Hello!");
    } finally {
      await worker.close();
    }
  }, 20_000);

  it("checkpoint replay: tool not re-executed after suspend+resume", async () => {
    sendMessageSpy.mockClear();

    // Scenario: write_file → sleep_for(1s) → text reply
    // After sleep, the write_file step should be replayed from checkpoint (not re-executed).
    // We verify by checking the file exists and sendMessage was called correctly.
    const writeAndSleepScenario: Scenario = {
      name: "write-and-sleep",
      turns: [
        {
          content: [
            toolUse(
              "write_file",
              { path: "data/notes/checkpoint-test.md", content: "written once" },
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

    taskDeps.anthropic = new FakeAnthropic(writeAndSleepScenario) as any;

    const recipientId = "telegram:300002";
    await db.absurd.spawn("handle-message", { recipientId, text: "Write and sleep" });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      // Wait for final message after resume
      await waitFor(() => {
        const calls = sendMessageSpy.mock.calls.map((c: any) => c[1]) as string[];
        return calls.includes("Woke up!");
      }, 20_000);

      // File should exist from the write_file tool (executed once before suspend)
      const filePath = path.join(tmpDir, "notes", "checkpoint-test.md");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("written once");

      // Both text messages should have been sent exactly once
      const messages = sentMessages(recipientId);
      expect(messages).toContain("File written, now sleeping.");
      expect(messages).toContain("Woke up!");
      // "File written, now sleeping." should appear exactly once (not re-sent on resume)
      expect(messages.filter((m) => m === "File written, now sleeping.")).toHaveLength(1);
    } finally {
      await worker.close();
    }
  }, 25_000);

  it("onText not re-sent on replay after suspend", async () => {
    sendMessageSpy.mockClear();

    // Scenario: text reply + sleep_for in same turn → resume → final text
    // The text from turn 0 should be sent exactly once, not again after resume.
    const textThenSleepScenario: Scenario = {
      name: "text-then-sleep",
      turns: [
        {
          content: [
            text("Sending before sleep."),
            toolUse("sleep_for", { step_name: "nap", seconds: 1 }, "tu-1"),
          ],
          stop_reason: "tool_use",
        },
        {
          content: [text("After sleep.")],
          stop_reason: "end_turn",
        },
      ],
    };

    taskDeps.anthropic = new FakeAnthropic(textThenSleepScenario) as any;

    const recipientId = "telegram:300003";
    await db.absurd.spawn("handle-message", { recipientId, text: "Text and sleep" });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => {
        const calls = sendMessageSpy.mock.calls.map((c: any) => c[1]) as string[];
        return calls.includes("After sleep.");
      }, 20_000);

      const messages = sentMessages(recipientId);

      // "Sending before sleep." must appear exactly once — not re-sent after resume
      expect(messages.filter((m) => m === "Sending before sleep.")).toHaveLength(1);
      expect(messages.filter((m) => m === "After sleep.")).toHaveLength(1);
    } finally {
      await worker.close();
    }
  }, 20_000);

  it("error propagation: tool error flows back to Claude as tool_result", async () => {
    sendMessageSpy.mockClear();

    // Scenario: read_file with a path that will fail → Claude gets the error → text reply
    const errorScenario: Scenario = {
      name: "tool-error",
      turns: [
        {
          // Read a file that doesn't exist — the tool returns "Error: ..." string
          content: [toolUse("read_file", { path: "data/notes/nonexistent-file.md" }, "tu-1")],
          stop_reason: "tool_use",
        },
        {
          content: [text("The file doesn't exist.")],
          stop_reason: "end_turn",
        },
      ],
    };

    const fake = new FakeAnthropic(errorScenario);
    taskDeps.anthropic = fake as any;

    const recipientId = "telegram:300004";
    await db.absurd.spawn("handle-message", { recipientId, text: "Read missing file" });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);

      expect(sendMessageSpy).toHaveBeenCalledWith(recipientId, "The file doesn't exist.");

      // Verify the tool_result containing the error was passed back to Claude.
      // The tool_result for tu-1 should appear in the second API request.
      expect(fake.allRequests.length).toBeGreaterThanOrEqual(2);
      const toolResultContent = findToolResult(fake.allRequests[1], "tu-1");
      expect(toolResultContent).toBeDefined();
      // read_file returns "(file not found)" for missing files
      expect(toolResultContent).toContain("not found");
    } finally {
      await worker.close();
    }
  }, 15_000);
});
