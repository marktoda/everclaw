// src/test/fake-anthropic.test.ts
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { FakeAnthropic } from "./fake-anthropic.ts";
import type { Scenario, ScenarioTurn } from "./fake-anthropic.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

function toolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id: string,
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

/** A minimal valid create() params object. */
function validParams(
  messages: Anthropic.MessageParam[] = [{ role: "user", content: "hello" }],
) {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages,
  };
}

/** Create a simple scenario with the given turns. */
function scenario(turns: ScenarioTurn[], name = "test-scenario"): Scenario {
  return { name, turns };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("FakeAnthropic", () => {
  // ── Basic operation ────────────────────────────────────────────────

  describe("basic operation", () => {
    it("returns scripted responses in order", async () => {
      const fake = new FakeAnthropic(
        scenario([
          { content: [textBlock("first")], stop_reason: "end_turn" },
          { content: [textBlock("second")], stop_reason: "end_turn" },
        ]),
      );

      const r1 = await fake.messages.create(validParams());
      expect(r1.content).toEqual([textBlock("first")]);
      expect(r1.stop_reason).toBe("end_turn");

      // Second call needs alternating messages (assistant then user)
      const r2 = await fake.messages.create(
        validParams([
          { role: "user", content: "hello" },
          { role: "assistant", content: [textBlock("first")] },
          { role: "user", content: "next" },
        ]),
      );
      expect(r2.content).toEqual([textBlock("second")]);
      expect(r2.stop_reason).toBe("end_turn");
    });

    it("tracks call count", async () => {
      const fake = new FakeAnthropic(
        scenario([
          { content: [textBlock("a")], stop_reason: "end_turn" },
          { content: [textBlock("b")], stop_reason: "end_turn" },
        ]),
      );

      expect(fake.callCount).toBe(0);
      await fake.messages.create(validParams());
      expect(fake.callCount).toBe(1);
      await fake.messages.create(
        validParams([
          { role: "user", content: "hi" },
          { role: "assistant", content: [textBlock("a")] },
          { role: "user", content: "next" },
        ]),
      );
      expect(fake.callCount).toBe(2);
    });

    it("throws when more calls than turns", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("only")], stop_reason: "end_turn" }]),
      );

      await fake.messages.create(validParams());
      await expect(
        fake.messages.create(
          validParams([
            { role: "user", content: "hi" },
            { role: "assistant", content: [textBlock("only")] },
            { role: "user", content: "more" },
          ]),
        ),
      ).rejects.toThrow(/exhausted/i);
    });

    it("assertAllTurnsConsumed passes when all used", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("done")], stop_reason: "end_turn" }]),
      );

      await fake.messages.create(validParams());
      expect(() => fake.assertAllTurnsConsumed()).not.toThrow();
    });

    it("assertAllTurnsConsumed throws when turns remain", async () => {
      const fake = new FakeAnthropic(
        scenario([
          { content: [textBlock("a")], stop_reason: "end_turn" },
          { content: [textBlock("b")], stop_reason: "end_turn" },
        ]),
      );

      await fake.messages.create(validParams());
      expect(() => fake.assertAllTurnsConsumed()).toThrow(/unconsumed/i);
    });

    it("stores deep clones of all requests", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("ok")], stop_reason: "end_turn" }]),
      );

      const params = validParams();
      await fake.messages.create(params);

      expect(fake.allRequests).toHaveLength(1);
      expect(fake.allRequests[0]).toEqual(params);
      // Verify it's a clone, not the same reference
      expect(fake.allRequests[0]).not.toBe(params);
    });
  });

  // ── Contract validation ────────────────────────────────────────────

  describe("contract validation", () => {
    it("rejects empty model", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow(/model/i);
    });

    it("rejects missing model", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: undefined as any,
          max_tokens: 1024,
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow(/model/i);
    });

    it("rejects max_tokens of 0", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 0,
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow(/max_tokens/i);
    });

    it("rejects empty messages array", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [],
        }),
      ).rejects.toThrow(/messages/i);
    });

    it("rejects messages not starting with user", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [{ role: "assistant", content: "hi" }],
        }),
      ).rejects.toThrow(/first message.*user/i);
    });

    it("rejects consecutive same-role messages", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "a" },
            { role: "user", content: "b" },
          ],
        }),
      ).rejects.toThrow(/alternat/i);
    });

    it("rejects tool_result without preceding tool_use", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "text only reply" },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "orphan-1", content: "result" },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/tool_result.*tool_use/i);
    });

    it("rejects orphan tool_use without following tool_result", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "do something" },
            {
              role: "assistant",
              content: [toolUseBlock("read_file", { path: "a.md" }, "tu-1")],
            },
            { role: "user", content: "where is the result?" },
          ],
        }),
      ).rejects.toThrow(/tool_use.*tool_result/i);
    });

    it("rejects tool_use at end of messages without following tool_result", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "do something" },
            {
              role: "assistant",
              content: [toolUseBlock("read_file", { path: "a.md" }, "tu-1")],
            },
          ],
        }),
      ).rejects.toThrow(/tool_use.*tool_result/i);
    });

    it("rejects mismatched tool_use/tool_result IDs", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("x")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "do something" },
            {
              role: "assistant",
              content: [toolUseBlock("read_file", { path: "a.md" }, "tu-1")],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-WRONG", content: "data" },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/mismatch|missing/i);
    });

    it("accepts valid tool_use followed by tool_result sequence", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("ok")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "read file" },
            {
              role: "assistant",
              content: [toolUseBlock("read_file", { path: "a.md" }, "tu-1")],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-1", content: "file data" },
              ],
            },
          ],
        }),
      ).resolves.toBeDefined();
    });

    it("accepts multiple tool_use + tool_result pairs", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("done")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "do stuff" },
            {
              role: "assistant",
              content: [
                toolUseBlock("read_file", { path: "a.md" }, "tu-1"),
                toolUseBlock("get_state", { namespace: "n", key: "k" }, "tu-2"),
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-1", content: "file data" },
                { type: "tool_result", tool_use_id: "tu-2", content: "state value" },
              ],
            },
          ],
        }),
      ).resolves.toBeDefined();
    });

    it("accepts a multi-turn tool conversation", async () => {
      const fake = new FakeAnthropic(
        scenario([{ content: [textBlock("all good")], stop_reason: "end_turn" }]),
      );

      await expect(
        fake.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "do stuff" },
            {
              role: "assistant",
              content: [toolUseBlock("read_file", { path: "a" }, "tu-1")],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-1", content: "data" },
              ],
            },
            {
              role: "assistant",
              content: [toolUseBlock("write_file", { path: "b", content: "x" }, "tu-2")],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-2", content: "ok" },
              ],
            },
          ],
        }),
      ).resolves.toBeDefined();
    });
  });
});
