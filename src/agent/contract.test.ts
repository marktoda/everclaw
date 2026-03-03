// src/agent/contract.test.ts — Layer 1 contract tests.
// These verify that the agent loop always produces API-valid message arrays.
// FakeAnthropic validates every messages.create call against the Anthropic API
// contract and throws on any violation, so the tests pass if no exception is thrown.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { AgentDeps } from "./loop.ts";

// ── Mocks ──────────────────────────────────────────────────────────────

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

vi.mock("./prompt.ts", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system-prompt"),
}));

vi.mock("fs/promises", () => ({
  readdir: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockResolvedValue(""),
}));

// ── Imports (after mocks are declared) ─────────────────────────────────

import { runAgentLoop } from "./loop.ts";
import { getRecentMessages } from "../memory/history.ts";
import { FakeAnthropic } from "../test/fake-anthropic.ts";
import {
  SIMPLE_TEXT_REPLY,
  SINGLE_TOOL_USE,
  MULTI_TOOL_PARALLEL,
  MULTI_TURN_TOOLS,
  TEXT_PLUS_TOOL,
  makeMaxTurnsScenario,
} from "../test/scenarios.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function createMockCtx(): TaskContext {
  return { step: vi.fn(async (_name: string, fn: () => Promise<any>) => fn()) } as any;
}

function createMockPool(): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

function baseDeps(fake: FakeAnthropic, overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    anthropic: fake as any,
    pool: createMockPool(),
    model: "claude-sonnet-4-20250514",
    notesDir: "/tmp/notes",
    skillsDir: "/tmp/skills",
    toolsDir: "/tmp/tools",
    maxHistory: 50,
    registry: {
      definitions: [],
      execute: vi.fn().mockResolvedValue("tool-result"),
      isSuspending: () => false,
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("contract tests — API-valid message arrays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Simple text reply
  it("simple text reply produces valid API calls", async () => {
    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    await runAgentLoop(ctx, 1, "hello", deps);

    fake.assertAllTurnsConsumed();
  });

  // 2. Single tool use
  it("single tool use produces valid tool_result pairing", async () => {
    const fake = new FakeAnthropic(SINGLE_TOOL_USE);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    await runAgentLoop(ctx, 1, "read the file", deps);

    fake.assertAllTurnsConsumed();
  });

  // 3. Parallel tool calls
  it("parallel tool calls produce valid multi-result pairing", async () => {
    const fake = new FakeAnthropic(MULTI_TOOL_PARALLEL);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    await runAgentLoop(ctx, 1, "read and get state", deps);

    fake.assertAllTurnsConsumed();
  });

  // 4. Multi-turn tool use
  it("multi-turn tool use maintains valid message sequence", async () => {
    const fake = new FakeAnthropic(MULTI_TURN_TOOLS);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    await runAgentLoop(ctx, 1, "read then write", deps);

    fake.assertAllTurnsConsumed();
  });

  // 5. Text + tool_use in same response
  it("text + tool_use in same response produces valid sequence", async () => {
    const fake = new FakeAnthropic(TEXT_PLUS_TOOL);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    await runAgentLoop(ctx, 1, "check something", deps);

    fake.assertAllTurnsConsumed();
  });

  // 6. Max turns exhaustion
  it("max turns exhaustion produces valid calls for all 20 turns", async () => {
    const scenario = makeMaxTurnsScenario();
    const fake = new FakeAnthropic(scenario);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    await runAgentLoop(ctx, 1, "loop forever", deps);

    expect(fake.callCount).toBe(20);
    fake.assertAllTurnsConsumed();
  });

  // 7. Reconstructed history with tool_use/tool_result is API-valid
  it("reconstructed history with tool_use/tool_result is API-valid", async () => {
    vi.mocked(getRecentMessages).mockResolvedValueOnce([
      { chatId: 1, role: "user", content: "remind me" },
      {
        chatId: 1,
        role: "assistant",
        content: "(tool use only)",
        toolUse: [{ id: "tu-hist-1", name: "set_state", input: { namespace: "n", key: "k", value: "v" } }],
      },
      {
        chatId: 1,
        role: "tool",
        content: "[tu-hist-1]: OK",
        toolUse: [{ tool_use_id: "tu-hist-1", content: "OK" }],
      },
      { chatId: 1, role: "assistant", content: "Done setting state." },
    ] as any);

    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    await runAgentLoop(ctx, 1, "follow up", deps);

    fake.assertAllTurnsConsumed();
  });

  // 8. Orphaned tool_result at start of history is cleaned up
  it("orphaned tool_result at start of history is cleaned up", async () => {
    // History starts with an orphaned tool_result (no preceding tool_use).
    // The loop's cleanup code drops it. After cleanup the remaining history
    // begins with a user message so the API contract is satisfied.
    vi.mocked(getRecentMessages).mockResolvedValueOnce([
      {
        chatId: 1,
        role: "tool",
        content: "[tu-orphan]: some result",
        toolUse: [{ tool_use_id: "tu-orphan", content: "some result" }],
      },
      { chatId: 1, role: "user", content: "thanks" },
      { chatId: 1, role: "assistant", content: "You're welcome!" },
    ] as any);

    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    // FakeAnthropic validates every request — if the orphaned tool_result
    // leaked through, it would throw a contract violation.
    await runAgentLoop(ctx, 1, "hello again", deps);

    fake.assertAllTurnsConsumed();
  });

  // 9. Mismatched tool_use/tool_result IDs mid-history are sanitized
  it("mismatched tool_use/tool_result IDs mid-history are sanitized", async () => {
    // Simulates concurrent persists interleaving messages — tool_result
    // references an ID not in the preceding assistant tool_use.
    vi.mocked(getRecentMessages).mockResolvedValueOnce([
      { chatId: 1, role: "user", content: "first" },
      { chatId: 1, role: "assistant", content: "ack" },
      { chatId: 1, role: "user", content: "second" },
      {
        chatId: 1,
        role: "assistant",
        content: "(tool use only)",
        toolUse: [{ id: "tu-A", name: "read_file", input: { path: "x" } }],
      },
      {
        chatId: 1,
        role: "tool",
        content: "[tu-B]: wrong-result",
        toolUse: [{ tool_use_id: "tu-B", content: "wrong-result" }],
      },
      { chatId: 1, role: "user", content: "third" },
      { chatId: 1, role: "assistant", content: "final" },
    ] as any);

    const fake = new FakeAnthropic(SIMPLE_TEXT_REPLY);
    const deps = baseDeps(fake);
    const ctx = createMockCtx();

    // FakeAnthropic validates the contract — if the mismatched IDs
    // leaked through, it would throw. The sanitizer should drop the
    // invalid pair and produce a clean messages array.
    await runAgentLoop(ctx, 1, "follow up", deps);

    fake.assertAllTurnsConsumed();
  });
});
