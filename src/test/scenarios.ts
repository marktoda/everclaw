// src/test/scenarios.ts — Pre-built conversation scenarios for testing the agent loop.
import type Anthropic from "@anthropic-ai/sdk";
import type { Scenario } from "./fake-anthropic.ts";

function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null };
}

function toolUse(name: string, input: Record<string, unknown>, id: string): Anthropic.ToolUseBlock {
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
      content: [toolUse("write_file", { path: "data/notes/b.md", content: "new" }, "tu-2")],
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

/** Three turns: write_file -> read_file -> text reply. Tests file round-trip. */
export const WRITE_AND_READ: Scenario = {
  name: "write-and-read",
  turns: [
    {
      content: [
        toolUse("write_file", { path: "data/notes/test.md", content: "hello world" }, "tu-1"),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [toolUse("read_file", { path: "data/notes/test.md" }, "tu-2")],
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
      content: [toolUse("set_state", { namespace: "test", key: "color", value: "blue" }, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [toolUse("get_state", { namespace: "test", key: "color" }, "tu-2")],
      stop_reason: "tool_use",
    },
    {
      content: [text("Your color is blue.")],
      stop_reason: "end_turn",
    },
  ],
};

// ── Orchestration scenarios ──────────────────────────────────────────

/** Two turns: sleep_for(1s) -> text reply. */
export const SLEEP_FOR: Scenario = {
  name: "sleep-for",
  turns: [
    {
      content: [toolUse("sleep_for", { step_name: "nap", seconds: 1 }, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [text("Slept and resumed.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: spawn_workflow -> text reply. */
export const SPAWN_WORKFLOW: Scenario = {
  name: "spawn-workflow",
  turns: [
    {
      content: [toolUse("spawn_workflow", { instructions: "Say hello" }, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [text("Workflow spawned.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: send_message tool -> text reply. */
export const SEND_MESSAGE_TOOL: Scenario = {
  name: "send-message-tool",
  turns: [
    {
      content: [toolUse("send_message", { text: "Background hello" }, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [text("Message sent.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: emit_event -> text reply. */
export const EMIT_EVENT: Scenario = {
  name: "emit-event",
  turns: [
    {
      content: [toolUse("emit_event", { event_name: "test-signal", payload: { ok: true } }, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [text("Event emitted.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: wait_for_event -> text reply. */
export const WAIT_FOR_EVENT: Scenario = {
  name: "wait-for-event",
  turns: [
    {
      content: [
        toolUse("wait_for_event", { event_name: "test-signal", timeout_seconds: 10 }, "tu-1"),
      ],
      stop_reason: "tool_use",
    },
    {
      content: [text("Event received.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Two turns: list_tasks -> text reply. */
export const LIST_TASKS: Scenario = {
  name: "list-tasks",
  turns: [
    {
      content: [toolUse("list_tasks", {}, "tu-1")],
      stop_reason: "tool_use",
    },
    {
      content: [text("Here are the tasks.")],
      stop_reason: "end_turn",
    },
  ],
};

/** Factory: sleep_until with dynamic ISO datetime. */
export function makeSleepUntilScenario(wakeAt: string): Scenario {
  return {
    name: "sleep-until",
    turns: [
      {
        content: [toolUse("sleep_until", { step_name: "alarm", wake_at: wakeAt }, "tu-1")],
        stop_reason: "tool_use",
      },
      {
        content: [text("Woke up on time.")],
        stop_reason: "end_turn",
      },
    ],
  };
}

/** Factory: cancel_task with dynamic task ID. */
export function makeCancelTaskScenario(taskId: string): Scenario {
  return {
    name: "cancel-task",
    turns: [
      {
        content: [toolUse("cancel_task", { task_id: taskId }, "tu-1")],
        stop_reason: "tool_use",
      },
      {
        content: [text("Task cancelled.")],
        stop_reason: "end_turn",
      },
    ],
  };
}

/** Factory: long sleep_for (300s) for tests needing a permanently sleeping task. */
export function makeLongSleepScenario(): Scenario {
  return {
    name: "long-sleep",
    turns: [
      {
        content: [toolUse("sleep_for", { step_name: "long-nap", seconds: 300 }, "tu-1")],
        stop_reason: "tool_use",
      },
    ],
  };
}

/**
 * Factory: combined scenario for spawn_workflow tests.
 * Parent calls spawn_workflow (2 turns), child replies (1 turn).
 * All turns consumed sequentially from one FakeAnthropic.
 */
export function makeSpawnWorkflowCombined(): Scenario {
  return {
    name: "spawn-workflow-combined",
    turns: [
      // Parent turn 1: call spawn_workflow
      {
        content: [toolUse("spawn_workflow", { instructions: "Say hello" }, "tu-1")],
        stop_reason: "tool_use",
      },
      // Parent turn 2: text reply
      {
        content: [text("Workflow spawned successfully.")],
        stop_reason: "end_turn",
      },
      // Child turn 1: text reply
      {
        content: [text("Hello from workflow!")],
        stop_reason: "end_turn",
      },
    ],
  };
}
