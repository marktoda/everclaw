// src/agent/loop.test.ts

import type Anthropic from "@anthropic-ai/sdk";
import type { TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  listScripts: vi.fn().mockResolvedValue([]),
}));

vi.mock("./prompt.ts", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system-prompt"),
}));

vi.mock("fs/promises", () => ({
  readdir: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockResolvedValue(""),
}));

// ── Imports (after mocks are declared) ─────────────────────────────────

import { appendMessage, getRecentMessages } from "../memory/history.ts";
import { runAgentLoop } from "./loop.ts";
import { buildSystemPrompt } from "./prompt.ts";

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a text content block matching the Anthropic API shape. */
function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

/** Create a tool_use content block matching the Anthropic API shape. */
function toolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id = `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`,
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

/** Build a mock messages.create response. */
function apiResponse(content: Anthropic.ContentBlock[], stop_reason: string = "end_turn") {
  return { content, stop_reason };
}

/**
 * Create a mock TaskContext.
 * `step()` simply runs the callback immediately and returns its result.
 */
function createMockCtx(): TaskContext & { step: ReturnType<typeof vi.fn> } {
  const step = vi.fn(async (_name: string, fn: () => Promise<any>) => fn());
  return { step } as any;
}

/**
 * Create a mock Anthropic client whose messages.create resolves a sequence.
 * Also captures a deep-copy snapshot of the `messages` arg at each call,
 * since the loop mutates the array after each API call.
 */
function createMockAnthropic(responses: ReturnType<typeof apiResponse>[]) {
  const snapshots: Array<{ messages: Anthropic.MessageParam[] }> = [];
  const create = vi.fn(({ messages }: any) => {
    // Snapshot the messages array at call time (shallow copy of elements)
    snapshots.push({ messages: [...messages] });
    return Promise.resolve(responses[create.mock.calls.length - 1]);
  });
  return {
    messages: { create },
    /** Deep-copy snapshots of messages at each call. */
    snapshots,
  } as any as Anthropic & {
    messages: { create: ReturnType<typeof vi.fn> };
    snapshots: Array<{ messages: Anthropic.MessageParam[] }>;
  };
}

function createMockPool(): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

function baseDeps(
  overrides: Partial<AgentDeps> & {
    executeTool?: (name: string, input: Record<string, any>) => Promise<string>;
    isSuspending?: (name: string) => boolean;
  } = {},
): AgentDeps {
  const { executeTool, isSuspending, ...rest } = overrides;
  return {
    anthropic: createMockAnthropic([]),
    pool: createMockPool(),
    model: "claude-sonnet-4-20250514",
    dirs: { notes: "/tmp/notes", skills: "/tmp/skills", scripts: "/tmp/scripts" },
    maxHistory: 50,
    registry: {
      definitions: [],
      execute: executeTool ?? vi.fn().mockResolvedValue("tool-result"),
      isSuspending: isSuspending ?? (() => false),
    },
    ...rest,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Simple text response ────────────────────────────────────────

  describe("simple text response", () => {
    it("returns the text when Claude responds with a text block", async () => {
      const anthropic = createMockAnthropic([apiResponse([textBlock("Hello there!")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "hi", deps);

      expect(result).toBe("Hello there!");
    });

    it("calls onText callback with filtered text", async () => {
      const onText = vi.fn();
      const anthropic = createMockAnthropic([apiResponse([textBlock("Hello!")])]);
      const deps = baseDeps({ anthropic, onText });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hi", deps);

      expect(onText).toHaveBeenCalledOnce();
      expect(onText).toHaveBeenCalledWith("Hello!");
    });

    it("persists user message and assistant reply to history", async () => {
      const anthropic = createMockAnthropic([apiResponse([textBlock("Reply")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:42", "user-msg", deps);

      // The first appendMessage call should be the user message
      const calls = vi.mocked(appendMessage).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0][1]).toMatchObject({
        chatId: "telegram:42",
        role: "user",
        content: "user-msg",
      });
      // The second should be the assistant reply
      expect(calls[1][1]).toMatchObject({
        chatId: "telegram:42",
        role: "assistant",
        content: "Reply",
      });
    });
  });

  // ── 2. Internal tag stripping ──────────────────────────────────────

  describe("internal tag stripping", () => {
    it("strips <internal>...</internal> tags from the final return value", async () => {
      const anthropic = createMockAnthropic([
        apiResponse([textBlock("<internal>thinking</internal>Visible text")]),
      ]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "hi", deps);

      expect(result).toBe("Visible text");
      expect(result).not.toContain("<internal>");
    });

    it("calls onText with stripped text (no internal tags)", async () => {
      const onText = vi.fn();
      const anthropic = createMockAnthropic([
        apiResponse([textBlock("<internal>secret</internal>Public")]),
      ]);
      const deps = baseDeps({ anthropic, onText });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hi", deps);

      expect(onText).toHaveBeenCalledWith("Public");
    });

    it("does not call onText when all text is internal", async () => {
      const onText = vi.fn();
      const anthropic = createMockAnthropic([
        apiResponse([textBlock("<internal>all hidden</internal>")]),
      ]);
      const deps = baseDeps({ anthropic, onText });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hi", deps);

      // stripInternalTags returns "" which is falsy, so onText should not be called
      expect(onText).not.toHaveBeenCalled();
    });
  });

  // ── 3. Tool use flow ───────────────────────────────────────────────

  describe("tool use flow", () => {
    it("executes a tool and feeds the result back to Claude", async () => {
      const executeTool = vi.fn().mockResolvedValue("tool-output");
      const toolBlock = toolUseBlock("read_file", { path: "data/notes/a.md" }, "tool-1");
      const anthropic = createMockAnthropic([
        apiResponse([toolBlock], "tool_use"),
        apiResponse([textBlock("Done reading")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "read notes", deps);

      expect(result).toBe("Done reading");
      expect(executeTool).toHaveBeenCalledWith("read_file", { path: "data/notes/a.md" });
    });

    it("sends tool_result back with the correct tool_use_id", async () => {
      const executeTool = vi.fn().mockResolvedValue("result-123");
      const tb = toolUseBlock("read_file", { path: "data/notes/test.md" }, "tool-abc");
      const anthropic = createMockAnthropic([
        apiResponse([tb], "tool_use"),
        apiResponse([textBlock("final")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "read file", deps);

      // Use the snapshot captured at call-time (avoids mutation issues)
      const snapshot = anthropic.snapshots[1];
      const msgs = snapshot.messages;
      const toolResultMsg = msgs[msgs.length - 1];
      expect(toolResultMsg.role).toBe("user");
      expect(toolResultMsg.content).toEqual([
        { type: "tool_result", tool_use_id: "tool-abc", content: "result-123" },
      ]);
    });
  });

  // ── 4. Multiple tool calls in one response ─────────────────────────

  describe("multiple tool calls", () => {
    it("handles multiple tool_use blocks in a single response", async () => {
      const executeTool = vi
        .fn()
        .mockResolvedValueOnce("result-a")
        .mockResolvedValueOnce("result-b");

      const tb1 = toolUseBlock("read_file", { path: "a" }, "id-1");
      const tb2 = toolUseBlock("write_file", { path: "b", content: "x" }, "id-2");
      const anthropic = createMockAnthropic([
        apiResponse([tb1, tb2], "tool_use"),
        apiResponse([textBlock("Both done")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "do both", deps);

      expect(result).toBe("Both done");
      expect(executeTool).toHaveBeenCalledTimes(2);
      expect(executeTool).toHaveBeenCalledWith("read_file", { path: "a" });
      expect(executeTool).toHaveBeenCalledWith("write_file", { path: "b", content: "x" });
    });

    it("sends all tool results back in a single user message", async () => {
      const executeTool = vi.fn().mockResolvedValueOnce("r1").mockResolvedValueOnce("r2");
      const tb1 = toolUseBlock("read_file", { path: "data/notes/test.md" }, "id-1");
      const tb2 = toolUseBlock(
        "write_file",
        { path: "data/notes/test.md", content: "test" },
        "id-2",
      );
      const anthropic = createMockAnthropic([
        apiResponse([tb1, tb2], "tool_use"),
        apiResponse([textBlock("ok")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "msg", deps);

      // Use snapshot captured at call-time
      const snapshot = anthropic.snapshots[1];
      const msgs = snapshot.messages;
      const toolResults = msgs[msgs.length - 1];
      expect(toolResults.content).toHaveLength(2);
      expect(toolResults.content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "id-1",
        content: "r1",
      });
      expect(toolResults.content[1]).toMatchObject({
        type: "tool_result",
        tool_use_id: "id-2",
        content: "r2",
      });
    });
  });

  // ── 5. SUSPENDING_TOOLS: not wrapped in ctx.step() ─────────────────

  describe("suspending tools", () => {
    const isSuspending = (name: string) =>
      ["sleep_for", "sleep_until", "wait_for_event"].includes(name);

    it.each([
      "sleep_for",
      "sleep_until",
      "wait_for_event",
    ])("does NOT wrap %s in ctx.step()", async (toolName) => {
      const executeTool = vi.fn().mockResolvedValue("resumed");
      const tb = toolUseBlock(toolName, { step_name: "s1" }, "sus-1");
      const anthropic = createMockAnthropic([
        apiResponse([tb], "tool_use"),
        apiResponse([textBlock("after suspend")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool, isSuspending });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "suspend", deps);

      // ctx.step should have been called for load-context, agent-turn-*,
      // send-text-*, and persist. But NOT for a tool-* step for suspending tools.
      const stepNames = ctx.step.mock.calls.map((c: any[]) => c[0] as string);
      const toolSteps = stepNames.filter((n: string) => n.startsWith("tool-"));
      expect(toolSteps).toHaveLength(0);

      // But the executeTool should still have been called directly
      expect(executeTool).toHaveBeenCalledWith(toolName, { step_name: "s1" });
    });
  });

  // ── 6. Non-suspending tools: wrapped in ctx.step() ─────────────────

  describe("non-suspending tools", () => {
    it.each([
      "read_file",
      "write_file",
      "glob_files",
      "grep_files",
      "run_script",
      "spawn_workflow",
      "spawn_skill",
      "send_message",
    ])("wraps %s in ctx.step()", async (toolName) => {
      const executeTool = vi.fn().mockResolvedValue("ok");
      const tb = toolUseBlock(toolName, {}, "ns-1");
      const anthropic = createMockAnthropic([
        apiResponse([tb], "tool_use"),
        apiResponse([textBlock("done")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "run", deps);

      const stepNames = ctx.step.mock.calls.map((c: any[]) => c[0] as string);
      expect(stepNames).toContain(`tool-0-ns-1`);
    });
  });

  // ── 7. Mixed suspending and non-suspending in one response ─────────

  describe("mixed tool types", () => {
    it("wraps non-suspending in step but not suspending", async () => {
      const executeTool = vi.fn().mockResolvedValue("ok");
      const isSuspending = (name: string) =>
        ["sleep_for", "sleep_until", "wait_for_event"].includes(name);
      const tb1 = toolUseBlock("read_file", { path: "x" }, "m-1");
      const tb2 = toolUseBlock("sleep_for", { step_name: "s", seconds: 10 }, "m-2");
      const anthropic = createMockAnthropic([
        apiResponse([tb1, tb2], "tool_use"),
        apiResponse([textBlock("mixed done")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool, isSuspending });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "mixed", deps);

      const stepNames = ctx.step.mock.calls.map((c: any[]) => c[0] as string);
      // read_file should be wrapped (using its tool_use_id)
      expect(stepNames).toContain("tool-0-m-1");
      // sleep_for should NOT appear as a tool step
      const suspendSteps = stepNames.filter((n: string) => n.includes("sleep_for"));
      expect(suspendSteps).toHaveLength(0);
    });
  });

  // ── 8. Multi-turn tool use ─────────────────────────────────────────

  describe("multi-turn tool use", () => {
    it("supports multiple tool turns before a final text response", async () => {
      const executeTool = vi.fn().mockResolvedValueOnce("r1").mockResolvedValueOnce("r2");
      const tb1 = toolUseBlock("read_file", {}, "mt-1");
      const tb2 = toolUseBlock("write_file", {}, "mt-2");
      const anthropic = createMockAnthropic([
        apiResponse([tb1], "tool_use"),
        apiResponse([tb2], "tool_use"),
        apiResponse([textBlock("all done")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "multi-turn", deps);

      expect(result).toBe("all done");
      expect(anthropic.messages.create).toHaveBeenCalledTimes(3);
      expect(executeTool).toHaveBeenCalledTimes(2);
    });
  });

  // ── 9. Max turns limit ─────────────────────────────────────────────

  describe("max turns", () => {
    it("stops after 50 turns and returns empty string if only tool_use", async () => {
      // Create an anthropic mock that always returns tool_use
      const tb = toolUseBlock("read_file", {}, "loop-1");
      const create = vi.fn().mockResolvedValue(apiResponse([tb], "tool_use"));
      const anthropic = { messages: { create } } as any;
      const executeTool = vi.fn().mockResolvedValue("ok");
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "infinite", deps);

      // messages.create is called once per turn => exactly 50 calls
      expect(create).toHaveBeenCalledTimes(50);
      // The reply variable starts as "" and never gets set to text
      // (since every response is tool_use), so the final return is "".
      expect(result).toBe("");
    });

    it("returns text from the last turn if Claude responds with text on the final turn", async () => {
      const tb = toolUseBlock("read_file", {}, "loop-1");
      const create = vi.fn();
      // 49 tool_use turns, then text on turn 50 (index 49)
      for (let i = 0; i < 49; i++) {
        create.mockResolvedValueOnce(apiResponse([tb], "tool_use"));
      }
      create.mockResolvedValueOnce(apiResponse([textBlock("finally")]));

      const anthropic = { messages: { create } } as any;
      const executeTool = vi.fn().mockResolvedValue("ok");
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "loops", deps);

      expect(result).toBe("finally");
      expect(create).toHaveBeenCalledTimes(50);
    });

    it("retries on max_tokens instead of silently stopping", async () => {
      const tb = toolUseBlock("write_file", { path: "test.md" }, "trunc-1");
      const anthropic = createMockAnthropic([
        // Turn 1: truncated (max_tokens)
        apiResponse([tb], "max_tokens"),
        // Turn 2: recovers with text
        apiResponse([textBlock("recovered")]),
      ]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "write big file", deps);

      expect(result).toBe("recovered");
      expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
      // Use snapshot to check the retry prompt was added
      const snapshot = anthropic.snapshots[1];
      const lastMsg = snapshot.messages[snapshot.messages.length - 1];
      expect(lastMsg.role).toBe("user");
      expect(lastMsg.content).toContain("cut off");
    });
  });

  // ── 10. onText callback ────────────────────────────────────────────

  describe("onText callback", () => {
    it("calls onText for each text block in each turn", async () => {
      const onText = vi.fn();
      const tb = toolUseBlock("read_file", {}, "ot-1");
      const anthropic = createMockAnthropic([
        // Turn 1: text block + tool_use
        apiResponse([textBlock("thinking..."), tb], "tool_use"),
        // Turn 2: final text
        apiResponse([textBlock("done")]),
      ]);
      const deps = baseDeps({ anthropic, onText, executeTool: vi.fn().mockResolvedValue("ok") });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hi", deps);

      expect(onText).toHaveBeenCalledTimes(2);
      expect(onText).toHaveBeenNthCalledWith(1, "thinking...");
      expect(onText).toHaveBeenNthCalledWith(2, "done");
    });

    it("calls onText for multiple text blocks in a single response", async () => {
      const onText = vi.fn();
      const anthropic = createMockAnthropic([
        apiResponse([textBlock("first"), textBlock("second")]),
      ]);
      const deps = baseDeps({ anthropic, onText });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hi", deps);

      expect(onText).toHaveBeenCalledTimes(2);
      expect(onText).toHaveBeenNthCalledWith(1, "first");
      expect(onText).toHaveBeenNthCalledWith(2, "second");
    });

    it("wraps onText in ctx.step to prevent re-sends on resume after suspend", async () => {
      const onText = vi.fn();
      const tb = toolUseBlock("sleep_for", { step_name: "s1", seconds: 5 }, "sus-1");
      const anthropic = createMockAnthropic([
        apiResponse([textBlock("Starting countdown..."), tb], "tool_use"),
        apiResponse([textBlock("Done!")]),
      ]);
      const executeTool = vi.fn().mockResolvedValue("resumed");
      const deps = baseDeps({ anthropic, onText, executeTool });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "count", deps);

      // onText should be wrapped in send-text-* steps
      const stepNames = ctx.step.mock.calls.map((c: any[]) => c[0] as string);
      expect(stepNames).toContain("send-text-0");
      expect(stepNames).toContain("send-text-1");

      // onText should still be called (the step executes on first run)
      expect(onText).toHaveBeenCalledTimes(2);
      expect(onText).toHaveBeenNthCalledWith(1, "Starting countdown...");
      expect(onText).toHaveBeenNthCalledWith(2, "Done!");
    });

    it("does not error if onText is not provided", async () => {
      const anthropic = createMockAnthropic([apiResponse([textBlock("hello")])]);
      const deps = baseDeps({ anthropic, onText: undefined });
      const ctx = createMockCtx();

      // Should not throw
      const result = await runAgentLoop(ctx, "telegram:1", "hi", deps);
      expect(result).toBe("hello");
    });
  });

  // ── 11. Context loading ────────────────────────────────────────────

  describe("context loading", () => {
    it("wraps context loading in ctx.step('load-context')", async () => {
      const anthropic = createMockAnthropic([apiResponse([textBlock("ok")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hi", deps);

      const stepNames = ctx.step.mock.calls.map((c: any[]) => c[0] as string);
      expect(stepNames[0]).toBe("load-context");
    });

    it("passes chatId and maxHistory to getRecentMessages", async () => {
      const anthropic = createMockAnthropic([apiResponse([textBlock("ok")])]);
      const deps = baseDeps({ anthropic, maxHistory: 25 });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:99", "hi", deps);

      expect(getRecentMessages).toHaveBeenCalledWith(deps.pool, "telegram:99", 25);
    });

    it("calls buildSystemPrompt with loaded context", async () => {
      const anthropic = createMockAnthropic([apiResponse([textBlock("ok")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hi", deps);

      expect(buildSystemPrompt).toHaveBeenCalledOnce();
    });
  });

  // ── 12. Conversation history ───────────────────────────────────────

  describe("conversation history", () => {
    it("includes previous messages from history in the API call", async () => {
      vi.mocked(getRecentMessages).mockResolvedValueOnce([
        { chatId: "telegram:1", role: "user", content: "previous question" },
        { chatId: "telegram:1", role: "assistant", content: "previous answer" },
      ] as any);

      const anthropic = createMockAnthropic([apiResponse([textBlock("new answer")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "follow-up", deps);

      // Use snapshot captured at call-time (before the array was mutated)
      const snapshot = anthropic.snapshots[0];
      const messages = snapshot.messages;

      // History messages + new user message
      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: "user", content: "previous question" });
      expect(messages[1]).toEqual({ role: "assistant", content: "previous answer" });
      expect(messages[2]).toEqual({ role: "user", content: "follow-up" });
    });

    it("skips tool messages without toolUse (old format, backwards compat)", async () => {
      vi.mocked(getRecentMessages).mockResolvedValueOnce([
        { chatId: "telegram:1", role: "user", content: "q1" },
        { chatId: "telegram:1", role: "tool", content: "tool output" },
        { chatId: "telegram:1", role: "assistant", content: "a1" },
      ] as any);

      const anthropic = createMockAnthropic([apiResponse([textBlock("answer")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "q2", deps);

      // Use snapshot captured at call-time
      const messages = anthropic.snapshots[0].messages;
      // Only user and assistant from history, plus the new user message
      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: "user", content: "q1" });
      expect(messages[1]).toEqual({ role: "assistant", content: "a1" });
      expect(messages[2]).toEqual({ role: "user", content: "q2" });
    });

    it("reconstructs tool_use and tool_result from history with toolUse metadata", async () => {
      vi.mocked(getRecentMessages).mockResolvedValueOnce([
        { chatId: "telegram:1", role: "user", content: "remind me" },
        {
          chatId: "telegram:1",
          role: "assistant",
          content: "(tool use only)",
          toolUse: [{ id: "tu-1", name: "spawn_workflow", input: { instructions: "do stuff" } }],
        },
        {
          chatId: "telegram:1",
          role: "tool",
          content: "[tu-1]: Task spawned",
          toolUse: [{ tool_use_id: "tu-1", content: "Task spawned" }],
        },
        { chatId: "telegram:1", role: "assistant", content: "Done!" },
      ] as any);

      const anthropic = createMockAnthropic([apiResponse([textBlock("hello")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "Hi", deps);

      const messages = anthropic.snapshots[0].messages;
      expect(messages).toHaveLength(5);

      // 1. Original user message
      expect(messages[0]).toEqual({ role: "user", content: "remind me" });

      // 2. Assistant with tool_use block (no text block for "(tool use only)")
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toEqual([
        {
          type: "tool_use",
          id: "tu-1",
          name: "spawn_workflow",
          input: { instructions: "do stuff" },
        },
      ]);

      // 3. Tool result as user message
      expect(messages[2].role).toBe("user");
      expect(messages[2].content).toEqual([
        { type: "tool_result", tool_use_id: "tu-1", content: "Task spawned" },
      ]);

      // 4. Final assistant text
      expect(messages[3]).toEqual({ role: "assistant", content: "Done!" });

      // 5. New user message
      expect(messages[4]).toEqual({ role: "user", content: "Hi" });
    });

    it("drops orphaned tool_result at start of history window", async () => {
      // Simulates a LIMIT-clipped history that starts with a tool_result
      vi.mocked(getRecentMessages).mockResolvedValueOnce([
        {
          chatId: "telegram:1",
          role: "tool",
          content: "[tu-1]: result",
          toolUse: [{ tool_use_id: "tu-1", content: "result" }],
        },
        { chatId: "telegram:1", role: "assistant", content: "Got it" },
        { chatId: "telegram:1", role: "user", content: "thanks" },
        { chatId: "telegram:1", role: "assistant", content: "Welcome!" },
      ] as any);

      const anthropic = createMockAnthropic([apiResponse([textBlock("hi")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hello", deps);

      const messages = anthropic.snapshots[0].messages;
      // Orphaned tool_result should be dropped; starts with "Got it"
      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({ role: "assistant", content: "Got it" });
      expect(messages[1]).toEqual({ role: "user", content: "thanks" });
      expect(messages[2]).toEqual({ role: "assistant", content: "Welcome!" });
      expect(messages[3]).toEqual({ role: "user", content: "hello" });
    });

    it("drops orphaned assistant tool_use without following tool_result", async () => {
      // History starts with an assistant tool_use but no following tool_result
      vi.mocked(getRecentMessages).mockResolvedValueOnce([
        {
          chatId: "telegram:1",
          role: "assistant",
          content: "(tool use only)",
          toolUse: [{ id: "tu-1", name: "read_file", input: { path: "x" } }],
        },
        { chatId: "telegram:1", role: "user", content: "hi" },
        { chatId: "telegram:1", role: "assistant", content: "hello" },
      ] as any);

      const anthropic = createMockAnthropic([apiResponse([textBlock("hey")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "yo", deps);

      const messages = anthropic.snapshots[0].messages;
      // Orphaned tool_use should be dropped
      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: "user", content: "hi" });
      expect(messages[1]).toEqual({ role: "assistant", content: "hello" });
      expect(messages[2]).toEqual({ role: "user", content: "yo" });
    });

    it("keeps valid tool_use + tool_result pair at start of history", async () => {
      vi.mocked(getRecentMessages).mockResolvedValueOnce([
        {
          chatId: "telegram:1",
          role: "assistant",
          content: "(tool use only)",
          toolUse: [{ id: "tu-1", name: "read_file", input: { path: "data/notes/test.md" } }],
        },
        {
          chatId: "telegram:1",
          role: "tool",
          content: "[tu-1]: value",
          toolUse: [{ tool_use_id: "tu-1", content: "value" }],
        },
        { chatId: "telegram:1", role: "assistant", content: "done" },
      ] as any);

      const anthropic = createMockAnthropic([apiResponse([textBlock("ok")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "q", deps);

      const messages = anthropic.snapshots[0].messages;
      // Pair is valid — both should be kept
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("assistant");
      expect(messages[1].role).toBe("user"); // tool_result
      expect((messages[1].content as any[])[0].type).toBe("tool_result");
      expect(messages[2]).toEqual({ role: "assistant", content: "done" });
      expect(messages[3]).toEqual({ role: "user", content: "q" });
    });
  });

  // ── 13. Persistence ────────────────────────────────────────────────

  describe("persistence", () => {
    it("wraps persistence in ctx.step('persist')", async () => {
      const anthropic = createMockAnthropic([apiResponse([textBlock("hi")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "msg", deps);

      const stepNames = ctx.step.mock.calls.map((c: any[]) => c[0] as string);
      expect(stepNames).toContain("persist");
    });

    it("persists tool_use and tool_result messages during a tool flow", async () => {
      const executeTool = vi.fn().mockResolvedValue("tool-result");
      const tb = toolUseBlock("read_file", { path: "data/notes/test.md" }, "tool-p");
      const anthropic = createMockAnthropic([
        apiResponse([tb], "tool_use"),
        apiResponse([textBlock("final answer")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:42", "q", deps);

      const calls = vi.mocked(appendMessage).mock.calls;

      // Expect: user message, assistant (tool_use), tool results, assistant (text)
      expect(calls.length).toBe(4);

      // 1. User message
      expect(calls[0][1]).toMatchObject({ chatId: "telegram:42", role: "user", content: "q" });

      // 2. Assistant with tool_use (includes id for history reconstruction)
      const assistantMsg = calls[1][1] as import("../memory/history.ts").AssistantMessage;
      expect(assistantMsg).toMatchObject({ chatId: "telegram:42", role: "assistant" });
      expect(assistantMsg.toolUse).toBeDefined();
      expect(assistantMsg.toolUse).toEqual([
        { id: "tool-p", name: "read_file", input: { path: "data/notes/test.md" } },
      ]);

      // 3. Tool results (structured toolUse for history reconstruction)
      const toolMsg = calls[2][1] as import("../memory/history.ts").ToolResultMessage;
      expect(toolMsg).toMatchObject({ chatId: "telegram:42", role: "tool" });
      expect(toolMsg.content).toContain("tool-p");
      expect(toolMsg.content).toContain("tool-result");
      expect(toolMsg.toolUse).toEqual([{ tool_use_id: "tool-p", content: "tool-result" }]);

      // 4. Final assistant text
      expect(calls[3][1]).toMatchObject({
        chatId: "telegram:42",
        role: "assistant",
        content: "final answer",
      });
    });

    it("stores '(tool use only)' when assistant has no text blocks", async () => {
      const executeTool = vi.fn().mockResolvedValue("result");
      const tb = toolUseBlock("run_script", { name: "test" }, "tool-no-text");
      const anthropic = createMockAnthropic([
        apiResponse([tb], "tool_use"),
        apiResponse([textBlock("done")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "run", deps);

      const calls = vi.mocked(appendMessage).mock.calls;
      // The first assistant message (tool_use only, no text) should have "(tool use only)"
      const assistantToolCall = calls.find(
        (c) => c[1].role === "assistant" && c[1].toolUse !== undefined,
      );
      expect(assistantToolCall).toBeDefined();
      expect(assistantToolCall?.[1].content).toBe("(tool use only)");
    });
  });

  // ── 14. API call parameters ────────────────────────────────────────

  describe("API call parameters", () => {
    it("passes model, system prompt, tools, and messages to Claude", async () => {
      vi.mocked(buildSystemPrompt).mockReturnValueOnce("custom-system-prompt");
      const anthropic = createMockAnthropic([apiResponse([textBlock("hi")])]);
      const definitions = [
        {
          name: "my_tool",
          description: "desc",
          input_schema: { type: "object" as const, properties: {} },
        },
      ];
      const deps = baseDeps({
        anthropic,
        model: "claude-sonnet-4-20250514",
        registry: { definitions, execute: vi.fn(), isSuspending: () => false },
      });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hello", deps);

      // The create mock is still called with all args; we can read non-message args from calls
      const callArgs = anthropic.messages.create.mock.calls[0][0];
      expect(callArgs.model).toBe("claude-sonnet-4-20250514");
      expect(callArgs.max_tokens).toBe(16384);
      expect(callArgs.system).toBe("custom-system-prompt");
      expect(callArgs.tools).toEqual(definitions);
    });
  });

  // ── 15. Agent turn step naming ─────────────────────────────────────

  describe("agent turn checkpointing", () => {
    it("names agent turns sequentially: agent-turn-0, agent-turn-1, ...", async () => {
      const executeTool = vi.fn().mockResolvedValue("ok");
      const tb = toolUseBlock("read_file", {}, "seq-1");
      const anthropic = createMockAnthropic([
        apiResponse([tb], "tool_use"),
        apiResponse([tb], "tool_use"),
        apiResponse([textBlock("done")]),
      ]);
      const deps = baseDeps({ anthropic, executeTool });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "multi", deps);

      const stepNames = ctx.step.mock.calls.map((c: any[]) => c[0] as string);
      expect(stepNames).toContain("agent-turn-0");
      expect(stepNames).toContain("agent-turn-1");
      expect(stepNames).toContain("agent-turn-2");
    });
  });

  // ── 16. Multiple text blocks joined ────────────────────────────────

  describe("multiple text blocks", () => {
    it("joins multiple text blocks with newlines for the return value", async () => {
      const anthropic = createMockAnthropic([
        apiResponse([textBlock("Line 1"), textBlock("Line 2")]),
      ]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "hi", deps);

      // The raw reply joins with \n, then stripInternalTags trims
      expect(result).toBe("Line 1\nLine 2");
    });
  });

  // ── 17. Text alongside tool_use ────────────────────────────────────

  describe("text alongside tool_use", () => {
    it("extracts text from a response that also contains tool_use", async () => {
      const onText = vi.fn();
      const tb = toolUseBlock("read_file", {}, "mixed-1");
      const anthropic = createMockAnthropic([
        apiResponse([textBlock("I will read the file"), tb], "tool_use"),
        apiResponse([textBlock("Here is the content")]),
      ]);
      const executeTool = vi.fn().mockResolvedValue("file data");
      const deps = baseDeps({ anthropic, executeTool, onText });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "read it", deps);

      expect(result).toBe("Here is the content");
      // onText called for both turns
      expect(onText).toHaveBeenNthCalledWith(1, "I will read the file");
      expect(onText).toHaveBeenNthCalledWith(2, "Here is the content");
    });
  });

  // ── 18. Empty history ──────────────────────────────────────────────

  describe("empty history", () => {
    it("works correctly with no prior conversation history", async () => {
      vi.mocked(getRecentMessages).mockResolvedValueOnce([]);
      const anthropic = createMockAnthropic([apiResponse([textBlock("first message")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      const result = await runAgentLoop(ctx, "telegram:1", "hello", deps);

      expect(result).toBe("first message");

      // Use snapshot captured at call-time (before array mutation)
      const messages = anthropic.snapshots[0].messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: "hello" });
    });
  });

  // ── 19. Mismatched tool_use/tool_result mid-history ────────────────

  describe("mismatched tool pairs in history", () => {
    it("drops mismatched tool_use/tool_result pair and still produces valid API call", async () => {
      // Simulates concurrent persists that interleave messages from two agent loops:
      // assistant tool_use [A] is followed by tool_result [B] — IDs don't match.
      vi.mocked(getRecentMessages).mockResolvedValueOnce([
        { chatId: "telegram:1", role: "user", content: "msg1" },
        { chatId: "telegram:1", role: "assistant", content: "ok" },
        { chatId: "telegram:1", role: "user", content: "msg2" },
        {
          chatId: "telegram:1",
          role: "assistant",
          content: "(tool use only)",
          toolUse: [{ id: "tu-A", name: "read_file", input: { path: "a" } }],
        },
        {
          chatId: "telegram:1",
          role: "tool",
          content: "[tu-B]: result",
          toolUse: [{ tool_use_id: "tu-B", content: "result" }],
        },
        { chatId: "telegram:1", role: "user", content: "msg3" },
        { chatId: "telegram:1", role: "assistant", content: "reply3" },
      ] as any);

      const anthropic = createMockAnthropic([apiResponse([textBlock("answer")])]);
      const deps = baseDeps({ anthropic });
      const ctx = createMockCtx();

      await runAgentLoop(ctx, "telegram:1", "hello", deps);

      // The mismatched pair should be dropped; the API call should succeed.
      const messages = anthropic.snapshots[0].messages;
      // msg1, ok, msg2+msg3 (merged consecutive users), reply3, hello
      expect(messages).toHaveLength(5);
      expect(messages[0]).toEqual({ role: "user", content: "msg1" });
      expect(messages[1]).toEqual({ role: "assistant", content: "ok" });
      expect(messages[2]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "msg2" },
          { type: "text", text: "msg3" },
        ],
      });
      expect(messages[3]).toEqual({ role: "assistant", content: "reply3" });
      expect(messages[4]).toEqual({ role: "user", content: "hello" });
    });
  });
});
