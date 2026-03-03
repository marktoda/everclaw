// src/test/scenarios.ts — Pre-built conversation scenarios for testing the agent loop.
import type Anthropic from "@anthropic-ai/sdk";
import type { Scenario } from "./fake-anthropic.ts";

function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null };
}

function toolUse(
  name: string,
  input: Record<string, unknown>,
  id: string,
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

/** One turn: text reply, end_turn. */
export const SIMPLE_TEXT_REPLY: Scenario = {
  name: "simple-text-reply",
  turns: [
    {
      content: [text("Hello!")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: tool_use(read_file) -> text reply. */
export const SINGLE_TOOL_USE: Scenario = {
  name: "single-tool-use",
  turns: [
    {
      content: [toolUse("read_file", { path: "data/notes/test.md" }, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [text("I read the file.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: parallel tool_use(read_file, get_state) -> text reply. */
export const MULTI_TOOL_PARALLEL: Scenario = {
  name: "multi-tool-parallel",
  turns: [
    {
      content: [
        toolUse("read_file", { path: "data/notes/test.md" }, "tu-1"),
        toolUse("get_state", { namespace: "test", key: "k" }, "tu-2"),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [text("Both done.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Three turns: read_file -> write_file -> text reply. */
export const MULTI_TURN_TOOLS: Scenario = {
  name: "multi-turn-tools",
  turns: [
    {
      content: [toolUse("read_file", { path: "data/notes/a.md" }, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [
        toolUse(
          "write_file",
          { path: "data/notes/b.md", content: "new" },
          "tu-2",
        ),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [text("Read and wrote files.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: text + tool_use in one response -> text reply. */
export const TEXT_PLUS_TOOL: Scenario = {
  name: "text-plus-tool",
  turns: [
    {
      content: [
        text("Let me check..."),
        toolUse("get_state", { namespace: "test", key: "k" }, "tu-1"),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [text("Found it.")],
      stop_reason: "end_turn",
    },
  ],
};

/**
 * Returns a scenario with 20 turns of tool_use(get_state), each with a unique
 * id "tu-0" through "tu-19". Useful for testing max-turn limits.
 */
export function makeMaxTurnsScenario(): Scenario {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    content: [
      toolUse("get_state", { namespace: "test", key: `k${i}` }, `tu-${i}`),
    ] as Anthropic.ContentBlock[],
    stop_reason: "tool_use" as const,
  }));
  return { name: "max-turns", turns };
}

/** Two turns: tool_use(sleep_for) -> text reply. Tests suspending tool handling. */
export const SUSPENDING_TOOL: Scenario = {
  name: "suspending-tool",
  turns: [
    {
      content: [
        toolUse(
          "sleep_for",
          { step_name: "wait-1", seconds: 0 },
          "tu-1",
        ),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [text("Woke up!")],
      stop_reason: "end_turn",
    },
  ],
};

/** Three turns: write_file -> read_file -> text reply. Tests file round-trip. */
export const WRITE_AND_READ: Scenario = {
  name: "write-and-read",
  turns: [
    {
      content: [
        toolUse(
          "write_file",
          { path: "data/notes/test.md", content: "hello world" },
          "tu-1",
        ),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [
        toolUse("read_file", { path: "data/notes/test.md" }, "tu-2"),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [text("File contains: hello world")],
      stop_reason: "end_turn",
    },
  ],
};

/** Three turns: set_state -> get_state -> text reply. Tests state round-trip. */
export const STATE_ROUNDTRIP: Scenario = {
  name: "state-roundtrip",
  turns: [
    {
      content: [
        toolUse(
          "set_state",
          { namespace: "test", key: "color", value: "blue" },
          "tu-1",
        ),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [
        toolUse("get_state", { namespace: "test", key: "color" }, "tu-2"),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [text("Your color is blue.")],
      stop_reason: "end_turn",
    },
  ],
};
