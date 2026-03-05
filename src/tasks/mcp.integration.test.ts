// src/tasks/mcp.integration.test.ts — MCP integration test.
// Verifies that MCP tools are discoverable and callable through the full
// agent loop + real Absurd worker + real Postgres pipeline.
// Uses a fake McpManager (implements the McpManager interface) to avoid
// needing a real child process + Zod dependency.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelRegistry } from "../channels/index.ts";
import type { Config } from "../config.ts";
import type { McpManager } from "../servers/manager.ts";
import type { Scenario } from "../test/fake-anthropic.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import type { TestDb } from "../test/harness.ts";
import { setupTestDb } from "../test/harness.ts";
import type { TaskDeps } from "./handle-message.ts";
import { registerHandleMessage } from "./handle-message.ts";
import { registerSendMessage } from "./send-message.ts";

function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null };
}

function toolUse(name: string, input: Record<string, unknown>, id: string): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
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

/** Fake McpManager that exposes a single "echo" tool without spawning a child process. */
function createFakeMcpManager(): McpManager {
  return {
    async start() {},
    async reload() {},
    definitions(): Anthropic.Tool[] {
      return [
        {
          name: "mcp_echo_echo",
          description: "Echoes back the input message",
          input_schema: {
            type: "object" as const,
            properties: { message: { type: "string", description: "Message to echo" } },
            required: ["message"],
          },
        },
      ];
    },
    async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
      if (toolName === "mcp_echo_echo") {
        return `echo: ${input.message}`;
      }
      return `Error: unknown tool "${toolName}"`;
    },
    serverSummaries() {
      return [{ name: "echo", description: "Echo test server" }];
    },
    async stop() {},
  };
}

let db: TestDb;
let tmpDir: string;
let taskDeps: TaskDeps;
let fakeMcp: McpManager;

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

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everclaw-mcp-test-"));
  const notesDir = path.join(tmpDir, "notes");
  const skillsDir = path.join(tmpDir, "skills");
  const scriptsDir = path.join(tmpDir, "scripts");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });

  fakeMcp = createFakeMcpManager();

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
    mcp: fakeMcp,
  };

  registerHandleMessage(db.absurd, taskDeps);
  registerSendMessage(db.absurd, channels);
}, 60_000);

afterAll(async () => {
  await db?.teardown();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const interval = 250;
  const iterations = Math.ceil(timeoutMs / interval);
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (condition()) return;
  }
  throw new Error("waitFor timed out");
}

describe("MCP integration tests", () => {
  it("MCP tool is callable through the full agent loop and task pipeline", async () => {
    sendMessageSpy.mockClear();

    // Scenario: call mcp_echo_echo → text reply
    const mcpScenario: Scenario = {
      name: "mcp-echo",
      turns: [
        {
          content: [toolUse("mcp_echo_echo", { message: "integration test" }, "tu-1")],
          stop_reason: "tool_use",
        },
        {
          content: [text("Echo replied.")],
          stop_reason: "end_turn",
        },
      ],
    };

    const fake = new FakeAnthropic(mcpScenario);
    taskDeps.anthropic = fake as any;

    const recipientId = "telegram:400001";
    await db.absurd.spawn("handle-message", { recipientId, text: "Call the echo tool" });
    const worker = await db.absurd.startWorker({ concurrency: 1, claimTimeout: 30 });

    try {
      await waitFor(() => sendMessageSpy.mock.calls.length >= 1, 15_000);

      expect(sendMessageSpy).toHaveBeenCalledWith(recipientId, "Echo replied.");

      // Verify the MCP tool_result was sent back to Claude correctly
      expect(fake.allRequests.length).toBeGreaterThanOrEqual(2);
      const toolResultContent = findToolResult(fake.allRequests[1], "tu-1");
      expect(toolResultContent).toBe("echo: integration test");
    } finally {
      await worker.close();
    }
  }, 15_000);
});
