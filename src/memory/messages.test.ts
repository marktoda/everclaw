import { describe, expect, it } from "vitest";
import type { Message } from "./history.ts";
import { deconstructMessages, reconstructMessages, sanitizeMessages } from "./messages.ts";

describe("reconstructMessages", () => {
  it("converts plain user/assistant history to MessageParam[]", () => {
    const history: Message[] = [
      { recipientId: "telegram:1", role: "user", content: "hello" },
      { recipientId: "telegram:1", role: "assistant", content: "hi" },
    ];
    const result = reconstructMessages(history);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("reconstructs assistant tool_use + tool_result pairs", () => {
    const history: Message[] = [
      { recipientId: "telegram:1", role: "user", content: "do it" },
      {
        recipientId: "telegram:1",
        role: "assistant",
        content: "(tool use only)",
        toolUse: [{ id: "tu-1", name: "read_file", input: { path: "a" } }],
      },
      {
        recipientId: "telegram:1",
        role: "tool",
        content: "[tu-1]: data",
        toolUse: [{ tool_use_id: "tu-1", content: "data" }],
      },
      { recipientId: "telegram:1", role: "assistant", content: "done" },
    ];
    const result = reconstructMessages(history);
    expect(result).toHaveLength(4);
    expect(result[1].role).toBe("assistant");
    expect((result[1].content as any[])[0].type).toBe("tool_use");
    expect(result[2].role).toBe("user");
    expect((result[2].content as any[])[0].type).toBe("tool_result");
  });

  it("sanitizes mismatched tool_use/tool_result IDs", () => {
    const history: Message[] = [
      { recipientId: "telegram:1", role: "user", content: "msg1" },
      { recipientId: "telegram:1", role: "assistant", content: "ok" },
      { recipientId: "telegram:1", role: "user", content: "msg2" },
      {
        recipientId: "telegram:1",
        role: "assistant",
        content: "(tool use only)",
        toolUse: [{ id: "tu-A", name: "read_file", input: {} }],
      },
      {
        recipientId: "telegram:1",
        role: "tool",
        content: "[tu-B]: wrong",
        toolUse: [{ tool_use_id: "tu-B", content: "wrong" }],
      },
      { recipientId: "telegram:1", role: "user", content: "msg3" },
      { recipientId: "telegram:1", role: "assistant", content: "reply" },
    ];
    const result = reconstructMessages(history);
    // Mismatched pair dropped, consecutive users merged
    expect(result.every((m, i) => i === 0 || result[i - 1].role !== m.role)).toBe(true);
  });

  it("drops orphaned tool_result at start", () => {
    const history: Message[] = [
      {
        recipientId: "telegram:1",
        role: "tool",
        content: "[tu-1]: data",
        toolUse: [{ tool_use_id: "tu-1", content: "data" }],
      },
      { recipientId: "telegram:1", role: "user", content: "hi" },
      { recipientId: "telegram:1", role: "assistant", content: "hello" },
    ];
    const result = reconstructMessages(history);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "hi" });
  });

  it("skips tool messages without toolUse (backwards compat)", () => {
    const history = [
      { recipientId: "telegram:1", role: "user", content: "q" },
      { recipientId: "telegram:1", role: "tool", content: "old format" },
      { recipientId: "telegram:1", role: "assistant", content: "a" },
    ] as Message[];
    const result = reconstructMessages(history);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "q" });
    expect(result[1]).toEqual({ role: "assistant", content: "a" });
  });
});

describe("deconstructMessages", () => {
  it("converts assistant text message to Message", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "hello", citations: null }],
      },
    ];
    const result = deconstructMessages("telegram:1", messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("hello");
  });

  it("converts assistant tool_use to Message with toolUse array", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "tu-1", name: "read_file", input: { path: "a" } },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "tu-1", content: "data" }],
      },
    ];
    const result = deconstructMessages("telegram:1", messages as any);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("assistant");
    expect((result[0] as any).toolUse).toEqual([
      { id: "tu-1", name: "read_file", input: { path: "a" } },
    ]);
    expect(result[1].role).toBe("tool");
    expect((result[1] as any).toolUse).toEqual([{ tool_use_id: "tu-1", content: "data" }]);
  });

  it("uses '(tool use only)' when assistant has no text blocks", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "tu-1", name: "get_state", input: {} }],
      },
    ];
    const result = deconstructMessages("telegram:1", messages as any);
    expect(result[0].content).toBe("(tool use only)");
  });
});

describe("sanitizeMessages", () => {
  it("passes through a clean conversation", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
      { role: "user" as const, content: "bye" },
      { role: "assistant" as const, content: "goodbye" },
    ];
    expect(sanitizeMessages(messages)).toEqual(messages);
  });

  it("passes through valid tool_use/tool_result pairs", () => {
    const messages = [
      { role: "user" as const, content: "do it" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-1", name: "read_file", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file data" }],
      },
      { role: "assistant" as const, content: "done" },
    ];
    expect(sanitizeMessages(messages as any)).toEqual(messages);
  });

  it("drops orphaned tool_result at the start", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "data" }],
      },
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(sanitizeMessages(messages as any)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("drops orphaned tool_result in the middle", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-orphan", content: "data" }],
      },
      { role: "user" as const, content: "next" },
      { role: "assistant" as const, content: "reply" },
    ];
    expect(sanitizeMessages(messages as any)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "next" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("drops assistant tool_use without following tool_result", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-1", name: "read_file", input: {} }],
      },
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(sanitizeMessages(messages as any)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("drops pair where tool_result has wrong IDs", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-A", name: "read_file", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-B", content: "data" }],
      },
      { role: "assistant" as const, content: "reply" },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("drops pair where tool_result has extra IDs (parallel mismatch)", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-A", name: "read_file", input: {} }],
      },
      {
        role: "user" as const,
        content: [
          { type: "tool_result", tool_use_id: "tu-A", content: "data" },
          { type: "tool_result", tool_use_id: "tu-B", content: "extra" },
        ],
      },
      { role: "assistant" as const, content: "reply" },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("drops pair where tool_result is missing one ID", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use", id: "tu-A", name: "read_file", input: {} },
          { type: "tool_use", id: "tu-B", name: "get_state", input: {} },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-A", content: "data" }],
      },
      { role: "assistant" as const, content: "reply" },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("merges consecutive same-role messages after dropping tool pair", () => {
    const messages = [
      { role: "user" as const, content: "msg1" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "msg2" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-X", name: "read_file", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-Y", content: "wrong" }],
      },
      { role: "user" as const, content: "msg3" },
      { role: "assistant" as const, content: "final" },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toEqual([
      { role: "user", content: "msg1" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "msg2\n\nmsg3" },
      { role: "assistant", content: "final" },
    ]);
  });

  it("extracts text from content block arrays when merging same-role messages", () => {
    // Two assistant messages with array content become adjacent after an
    // orphaned tool_result between them is dropped in Pass 1.
    const messages = [
      { role: "user" as const, content: "question" },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "part one" }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-orphan", content: "stale" }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "part two" }],
      },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "question" });
    // Text extracted from content block arrays, not silently dropped
    expect(result[1].content).toBe("part one\n\npart two");
  });

  it("drops tool_use at the very end with no following message", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-1", name: "read_file", input: {} }],
      },
    ];
    const result = sanitizeMessages(messages as any);
    // tool_use dropped, only user message remains
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("merges three consecutive same-role messages after multiple drops", () => {
    const messages = [
      { role: "user" as const, content: "msg1" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-A", name: "read_file", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-X", content: "wrong" }],
      },
      { role: "user" as const, content: "msg2" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use", id: "tu-B", name: "get_state", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-Y", content: "wrong" }],
      },
      { role: "user" as const, content: "msg3" },
      { role: "assistant" as const, content: "final" },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toEqual([
      { role: "user", content: "msg1\n\nmsg2\n\nmsg3" },
      { role: "assistant", content: "final" },
    ]);
  });

  it("drops assistant text+tool_use when tool_result is missing", () => {
    // Assistant message has both text and tool_use, but no valid tool_result follows.
    // The entire assistant message (including text) gets dropped.
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "Let me check..." },
          { type: "tool_use", id: "tu-1", name: "get_state", input: {} },
        ],
      },
      { role: "user" as const, content: "never mind" },
      { role: "assistant" as const, content: "ok" },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toEqual([
      { role: "user", content: "hi\n\nnever mind" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("returns single message when everything else is dropped", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu-orphan", content: "stale" }],
      },
      { role: "user" as const, content: "only survivor" },
    ];
    const result = sanitizeMessages(messages as any);
    expect(result).toEqual([{ role: "user", content: "only survivor" }]);
  });

  it("handles empty messages array", () => {
    expect(sanitizeMessages([])).toEqual([]);
  });

  it("keeps valid parallel tool calls with matching IDs", () => {
    const messages = [
      { role: "user" as const, content: "do both" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use", id: "tu-1", name: "read_file", input: {} },
          { type: "tool_use", id: "tu-2", name: "get_state", input: {} },
        ],
      },
      {
        role: "user" as const,
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "file" },
          { type: "tool_result", tool_use_id: "tu-2", content: "state" },
        ],
      },
      { role: "assistant" as const, content: "done" },
    ];
    expect(sanitizeMessages(messages as any)).toEqual(messages);
  });
});
