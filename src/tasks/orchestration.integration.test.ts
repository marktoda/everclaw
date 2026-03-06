// src/tasks/orchestration.integration.test.ts — Layer 3 orchestration integration tests.
// Verifies that orchestration tools (sleep_for, sleep_until, wait_for_event, emit_event,
// spawn_workflow, send_message, cancel_task, list_tasks) actually suspend, resume, spawn,
// and coordinate through real Absurd + real Postgres (Testcontainers).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelRegistry } from "../channels/index.ts";
import type { Config } from "../config.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import type { TestDb } from "../test/harness.ts";
import { setupTestDb, waitFor, waitForAsync } from "../test/harness.ts";
import {
  LIST_TASKS,
  makeCancelTaskScenario,
  makeLongSleepScenario,
  makeSleepUntilScenario,
  makeSpawnWorkflowCombined,
  SEND_MESSAGE_TOOL,
  SLEEP_FOR,
  WAIT_FOR_EVENT,
} from "../test/scenarios.ts";
import { registerExecuteSkill } from "./execute-skill.ts";
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

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everclaw-orch-test-"));
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
    gmailLabel: "everclaw",
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
  registerExecuteSkill(db.absurd, taskDeps);
}, 60_000);

afterAll(async () => {
  await db?.teardown();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/** Query the run state of a task by its task_id. */
async function getRunState(taskId: string): Promise<string | null> {
  const result = await db.pool.query(
    `SELECT r.state FROM absurd.r_test r
     JOIN absurd.t_test t ON t.last_attempt_run = r.run_id
     WHERE t.task_id = $1`,
    [taskId],
  );
  return result.rows[0]?.state ?? null;
}

describe("orchestration integration tests", () => {
  it("sleep_for: task suspends and resumes after 1 second", async () => {
    sendMessageSpy.mockClear();
    taskDeps.anthropic = new FakeAnthropic(SLEEP_FOR) as any;

    await db.absurd.spawn("handle-message", {
      chatId: "telegram:200001",
      text: "Sleep for a bit",
    });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 20_000);
      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:200001", "Slept and resumed.");
    } finally {
      await worker.close();
    }
  }, 20_000);

  it("sleep_until: task suspends and resumes at target time", async () => {
    sendMessageSpy.mockClear();
    const wakeAt = new Date(Date.now() + 1500).toISOString();
    taskDeps.anthropic = new FakeAnthropic(makeSleepUntilScenario(wakeAt)) as any;

    await db.absurd.spawn("handle-message", {
      chatId: "telegram:200002",
      text: "Wake me up",
    });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 20_000);
      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:200002", "Woke up on time.");
    } finally {
      await worker.close();
    }
  }, 20_000);

  it("wait_for_event + emit_event: cross-task event coordination", async () => {
    sendMessageSpy.mockClear();
    taskDeps.anthropic = new FakeAnthropic(WAIT_FOR_EVENT) as any;

    const spawnResult = await db.absurd.spawn("handle-message", {
      chatId: "telegram:200003",
      text: "Wait for signal",
    });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      // Wait until the task is sleeping (waiting for event)
      await waitForAsync(async () => {
        const state = await getRunState(spawnResult.taskID);
        return state === "sleeping";
      }, 15_000);

      // Emit the event from test code
      await db.absurd.emitEvent("test-signal", { ok: true });

      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);
      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:200003", "Event received.");
    } finally {
      await worker.close();
    }
  }, 20_000);

  it("spawn_workflow: parent spawns child that completes", async () => {
    sendMessageSpy.mockClear();
    taskDeps.anthropic = new FakeAnthropic(makeSpawnWorkflowCombined()) as any;

    await db.absurd.spawn("handle-message", {
      chatId: "telegram:200004",
      text: "Spawn a workflow",
    });
    const worker = await db.absurd.startWorker({ concurrency: 2, claimTimeout: 30 });

    try {
      // Parent (handle-message) sends text via onText; child (workflow) is silent.
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);

      const messages = sendMessageSpy.mock.calls.map((c: any) => c[1]);
      expect(messages).toContain("Workflow spawned successfully.");
      // Child workflow runs in silent mode — "Hello from workflow!" is NOT auto-sent.
      // The child would need to use send_message tool explicitly to notify the user.
    } finally {
      await worker.close();
    }
  }, 15_000);

  it("send_message tool: spawns send-message task", async () => {
    sendMessageSpy.mockClear();
    taskDeps.anthropic = new FakeAnthropic(SEND_MESSAGE_TOOL) as any;

    await db.absurd.spawn("handle-message", {
      chatId: "telegram:200005",
      text: "Send a background message",
    });
    const worker = await db.absurd.startWorker({ concurrency: 2, claimTimeout: 30 });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 2, 15_000);

      const messages = sendMessageSpy.mock.calls.map((c: any) => c[1]);
      expect(messages).toContain("Background hello");
      expect(messages).toContain("Message sent.");
    } finally {
      await worker.close();
    }
  }, 15_000);

  it("cancel_task: cancels a sleeping task", async () => {
    sendMessageSpy.mockClear();

    // Spawn a workflow that sleeps for 300s
    taskDeps.anthropic = new FakeAnthropic(makeLongSleepScenario()) as any;
    const sleepResult = await db.absurd.spawn("workflow", {
      chatId: "telegram:200006",
      instructions: "Sleep forever",
    });
    const worker = await db.absurd.startWorker({ concurrency: 2, claimTimeout: 30 });

    try {
      // Wait until the task is sleeping
      await waitForAsync(async () => {
        const state = await getRunState(sleepResult.taskID);
        return state === "sleeping";
      }, 15_000);

      // Now swap FakeAnthropic and spawn cancel task
      sendMessageSpy.mockClear();
      taskDeps.anthropic = new FakeAnthropic(makeCancelTaskScenario(sleepResult.taskID)) as any;

      await db.absurd.spawn("handle-message", {
        chatId: "telegram:200006",
        text: "Cancel that task",
      });

      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);
      expect(sendMessageSpy).toHaveBeenCalledWith("telegram:200006", "Task cancelled.");

      // Verify the task is actually cancelled in the DB
      const result = await db.pool.query(`SELECT state FROM absurd.t_test WHERE task_id = $1`, [
        sleepResult.taskID,
      ]);
      expect(result.rows[0].state).toBe("cancelled");
    } finally {
      await worker.close();
    }
  }, 20_000);

  it("list_tasks: returns active tasks", async () => {
    sendMessageSpy.mockClear();

    // Spawn a workflow that sleeps for 300s
    taskDeps.anthropic = new FakeAnthropic(makeLongSleepScenario()) as any;
    const sleepResult = await db.absurd.spawn("workflow", {
      chatId: "telegram:200007",
      instructions: "Sleep forever",
    });
    const worker = await db.absurd.startWorker({ concurrency: 2, claimTimeout: 30 });

    try {
      // Wait until the task is sleeping
      await waitForAsync(async () => {
        const state = await getRunState(sleepResult.taskID);
        return state === "sleeping";
      }, 15_000);

      // Swap FakeAnthropic and spawn list_tasks
      const listFake = new FakeAnthropic(LIST_TASKS);
      taskDeps.anthropic = listFake as any;

      await db.absurd.spawn("handle-message", {
        chatId: "telegram:200007",
        text: "List tasks",
      });

      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);

      // Verify the tool_result in the captured request contains "workflow" and "sleeping"
      const lastRequest = listFake.allRequests[listFake.allRequests.length - 1];
      const allContent = lastRequest.messages
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .filter((b: any) => b.type === "tool_result")
        .map((b: any) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)));
      const toolResultText = allContent.join(" ");
      expect(toolResultText).toContain("workflow");
      expect(toolResultText).toContain("sleeping");
    } finally {
      // Cleanup: cancel the sleeping task
      await db.absurd.cancelTask(sleepResult.taskID);
      await worker.close();
    }
  }, 20_000);
});
