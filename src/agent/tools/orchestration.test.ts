import { describe, expect, it, vi } from "vitest";
import { orchestrationTools } from "./orchestration.ts";
import type { ExecutorDeps } from "./types.ts";

// ---- Helpers ----

function findTool(name: string) {
  const tool = orchestrationTools.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

function makeDeps(overrides?: Partial<ExecutorDeps>): ExecutorDeps {
  return {
    absurd: {
      spawn: vi.fn().mockResolvedValue({ taskID: "task-123" }),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    },
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    },
    ctx: {
      sleepFor: vi.fn().mockResolvedValue(undefined),
      sleepUntil: vi.fn().mockResolvedValue(undefined),
      awaitEvent: vi.fn().mockResolvedValue(null),
      emitEvent: vi.fn().mockResolvedValue(undefined),
    },
    chatId: "telegram:42",
    queueName: "test_queue",
    allowedChatIds: new Set(["telegram:42", "discord:99"]),
    ...overrides,
  } as unknown as ExecutorDeps;
}

// ---- resolveChat (tested indirectly via tools that use it) ----

describe("resolveChat (via spawn_workflow)", () => {
  const tool = findTool("spawn_workflow");

  it("uses current chatId when recipient is omitted", async () => {
    const deps = makeDeps();
    await tool.execute({ instructions: "do stuff" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith(
      "workflow",
      expect.objectContaining({ chatId: "telegram:42" }),
    );
  });

  it('uses current chatId when recipient is "current"', async () => {
    const deps = makeDeps();
    await tool.execute({ instructions: "do stuff", recipient: "current" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith(
      "workflow",
      expect.objectContaining({ chatId: "telegram:42" }),
    );
  });

  it("uses explicit recipient when provided and allowed", async () => {
    const deps = makeDeps();
    await tool.execute({ instructions: "do stuff", recipient: "discord:99" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith(
      "workflow",
      expect.objectContaining({ chatId: "discord:99" }),
    );
  });

  it("returns error when recipient is not in allowed list", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ instructions: "do stuff", recipient: "slack:999" }, deps);
    expect(result).toContain("Error:");
    expect(result).toContain("not in the allowed list");
    expect(deps.absurd.spawn).not.toHaveBeenCalled();
  });

  it("allows any recipient when allowedChatIds is empty", async () => {
    const deps = makeDeps({ allowedChatIds: new Set() });
    await tool.execute({ instructions: "do stuff", recipient: "slack:999" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith(
      "workflow",
      expect.objectContaining({ chatId: "slack:999" }),
    );
  });
});

// ---- sleep_for ----

describe("sleep_for", () => {
  const tool = findTool("sleep_for");

  it("is marked as suspending", () => {
    expect(tool.suspends).toBe(true);
  });

  it("calls ctx.sleepFor and returns resume message", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ step_name: "check-1", seconds: 60 }, deps);
    expect(deps.ctx.sleepFor).toHaveBeenCalledWith("check-1", 60);
    expect(result).toBe("Resumed after sleeping 60s.");
  });
});

// ---- sleep_until ----

describe("sleep_until", () => {
  const tool = findTool("sleep_until");

  it("is marked as suspending", () => {
    expect(tool.suspends).toBe(true);
  });

  it("calls ctx.sleepUntil with parsed date", async () => {
    const deps = makeDeps();
    const result = await tool.execute(
      { step_name: "wake-1", wake_at: "2026-03-15T17:00:00Z" },
      deps,
    );
    expect(deps.ctx.sleepUntil).toHaveBeenCalledWith("wake-1", new Date("2026-03-15T17:00:00Z"));
    expect(result).toContain("Resumed.");
  });

  it("returns error for invalid datetime", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ step_name: "wake-bad", wake_at: "not-a-date" }, deps);
    expect(result).toContain("Error: invalid datetime");
    expect(result).toContain("not-a-date");
    expect(deps.ctx.sleepUntil).not.toHaveBeenCalled();
  });
});

// ---- spawn_workflow ----

describe("spawn_workflow", () => {
  const tool = findTool("spawn_workflow");

  it("spawns a workflow task and returns task ID", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ instructions: "run report" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith("workflow", {
      chatId: "telegram:42",
      instructions: "run report",
    });
    expect(result).toBe("Workflow spawned (ID: task-123)");
  });

  it("includes context when provided", async () => {
    const deps = makeDeps();
    await tool.execute({ instructions: "run report", context: "some context" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith("workflow", {
      chatId: "telegram:42",
      instructions: "run report",
      context: "some context",
    });
  });

  it("omits context when not provided", async () => {
    const deps = makeDeps();
    await tool.execute({ instructions: "run report" }, deps);
    const params = vi.mocked(deps.absurd.spawn).mock.calls[0][1];
    expect(params).not.toHaveProperty("context");
  });

  it("uses recipient override", async () => {
    const deps = makeDeps();
    await tool.execute({ instructions: "alert user", recipient: "discord:99" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith(
      "workflow",
      expect.objectContaining({ chatId: "discord:99" }),
    );
  });
});

// ---- spawn_skill ----

describe("spawn_skill", () => {
  const tool = findTool("spawn_skill");

  it("spawns an execute-skill task and returns task ID", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ skill_name: "morning-check" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith("execute-skill", {
      skillName: "morning-check",
      chatId: "telegram:42",
    });
    expect(result).toBe('Skill "morning-check" spawned (ID: task-123)');
  });
});

// ---- send_message ----

describe("send_message", () => {
  const tool = findTool("send_message");

  it("spawns a send-message task with current chatId", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ text: "hello world" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith("send-message", {
      chatId: "telegram:42",
      text: "hello world",
    });
    expect(result).toBe("Message queued (ID: task-123)");
  });

  it("uses explicit recipient when provided", async () => {
    const deps = makeDeps();
    await tool.execute({ text: "alert!", recipient: "discord:99" }, deps);
    expect(deps.absurd.spawn).toHaveBeenCalledWith("send-message", {
      chatId: "discord:99",
      text: "alert!",
    });
  });

  it("returns error for disallowed recipient", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ text: "hello", recipient: "whatsapp:unknown" }, deps);
    expect(result).toContain("Error:");
    expect(result).toContain("not in the allowed list");
    expect(deps.absurd.spawn).not.toHaveBeenCalled();
  });
});

// ---- cancel_task ----

describe("cancel_task", () => {
  const tool = findTool("cancel_task");

  it("cancels a task and returns confirmation", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ task_id: "abc-123" }, deps);
    expect(deps.absurd.cancelTask).toHaveBeenCalledWith("abc-123");
    expect(result).toBe("Task abc-123 cancelled.");
  });

  it("returns friendly message when task is not found", async () => {
    const deps = makeDeps();
    vi.mocked(deps.absurd.cancelTask).mockRejectedValue(new Error("not found"));
    const result = await tool.execute({ task_id: "gone-456" }, deps);
    expect(result).toContain("gone-456");
    expect(result).toContain("not found");
  });

  it("rethrows unexpected errors", async () => {
    const deps = makeDeps();
    vi.mocked(deps.absurd.cancelTask).mockRejectedValue(new Error("db crash"));
    await expect(tool.execute({ task_id: "x" }, deps)).rejects.toThrow("db crash");
  });
});

// ---- list_tasks ----

describe("list_tasks", () => {
  const tool = findTool("list_tasks");

  it("returns 'No active tasks.' when rows are empty", async () => {
    const deps = makeDeps();
    const result = await tool.execute({}, deps);
    expect(result).toBe("No active tasks.");
  });

  it("formats rows with task info", async () => {
    const deps = makeDeps();
    vi.mocked(deps.pool.query).mockResolvedValue({
      rows: [
        {
          task_id: "t-1",
          task_name: "workflow",
          params: { instructions: "check weather" },
          run_state: "running",
        },
        {
          task_id: "t-2",
          task_name: "send-message",
          params: { text: "hello" },
          run_state: "sleeping",
          available_at: "2026-03-22T12:00:00Z",
        },
      ],
    } as any);
    const result = await tool.execute({}, deps);
    expect(result).toContain("workflow (t-1) state=running");
    expect(result).toContain('"check weather"');
    expect(result).toContain("send-message (t-2) state=sleeping");
    expect(result).toContain('"hello"');
    expect(result).toContain("wakes=");
  });

  it("shows skill name when params has skillName", async () => {
    const deps = makeDeps();
    vi.mocked(deps.pool.query).mockResolvedValue({
      rows: [
        {
          task_id: "t-3",
          task_name: "execute-skill",
          params: { skillName: "daily-report" },
          run_state: "running",
        },
      ],
    } as any);
    const result = await tool.execute({}, deps);
    expect(result).toContain("skill=daily-report");
  });

  it("truncates long instructions at 80 chars", async () => {
    const deps = makeDeps();
    const longText = "a".repeat(100);
    vi.mocked(deps.pool.query).mockResolvedValue({
      rows: [
        {
          task_id: "t-4",
          task_name: "workflow",
          params: { instructions: longText },
          run_state: "running",
        },
      ],
    } as any);
    const result = await tool.execute({}, deps);
    expect(result).toContain(`${"a".repeat(80)}...`);
  });

  it("handles rows with no params", async () => {
    const deps = makeDeps();
    vi.mocked(deps.pool.query).mockResolvedValue({
      rows: [
        {
          task_id: "t-5",
          task_name: "workflow",
          run_state: "pending",
        },
      ],
    } as any);
    const result = await tool.execute({}, deps);
    expect(result).toContain("workflow (t-5) state=pending");
  });

  it("uses queueName in the SQL query", async () => {
    const deps = makeDeps({ queueName: "my_queue" } as any);
    await tool.execute({}, deps);
    const sql = vi.mocked(deps.pool.query).mock.calls[0][0] as string;
    expect(sql).toContain("absurd.t_my_queue");
    expect(sql).toContain("absurd.r_my_queue");
  });
});

// ---- wait_for_event ----

describe("wait_for_event", () => {
  const tool = findTool("wait_for_event");

  it("is marked as suspending", () => {
    expect(tool.suspends).toBe(true);
  });

  it("calls ctx.awaitEvent and returns payload on success", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ctx.awaitEvent).mockResolvedValue({ data: "hello" });
    const result = await tool.execute({ event_name: "done:abc" }, deps);
    expect(deps.ctx.awaitEvent).toHaveBeenCalledWith("done:abc", {
      timeout: undefined,
    });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ received: true, payload: { data: "hello" } });
  });

  it("passes timeout_seconds to awaitEvent", async () => {
    const deps = makeDeps();
    await tool.execute({ event_name: "evt", timeout_seconds: 30 }, deps);
    expect(deps.ctx.awaitEvent).toHaveBeenCalledWith("evt", { timeout: 30 });
  });

  it("returns timed_out response on TimeoutError", async () => {
    // Import the real TimeoutError to throw
    const { TimeoutError } = await import("absurd-sdk");
    const deps = makeDeps();
    vi.mocked(deps.ctx.awaitEvent).mockRejectedValue(new TimeoutError("timed out"));
    const result = await tool.execute({ event_name: "evt" }, deps);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ received: false, timed_out: true });
  });

  it("rethrows non-timeout errors", async () => {
    const deps = makeDeps();
    vi.mocked(deps.ctx.awaitEvent).mockRejectedValue(new Error("boom"));
    await expect(tool.execute({ event_name: "evt" }, deps)).rejects.toThrow("boom");
  });
});

// ---- emit_event ----

describe("emit_event", () => {
  const tool = findTool("emit_event");

  it("calls ctx.emitEvent and returns confirmation", async () => {
    const deps = makeDeps();
    const result = await tool.execute({ event_name: "done:abc" }, deps);
    expect(deps.ctx.emitEvent).toHaveBeenCalledWith("done:abc", null);
    expect(result).toBe('Event "done:abc" emitted.');
  });

  it("passes payload to emitEvent", async () => {
    const deps = makeDeps();
    await tool.execute({ event_name: "result", payload: { status: "ok" } }, deps);
    expect(deps.ctx.emitEvent).toHaveBeenCalledWith("result", { status: "ok" });
  });

  it("passes null when payload is undefined", async () => {
    const deps = makeDeps();
    await tool.execute({ event_name: "ping" }, deps);
    expect(deps.ctx.emitEvent).toHaveBeenCalledWith("ping", null);
  });
});
