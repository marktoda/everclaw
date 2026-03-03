import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mocks ----

vi.mock("../agent/loop.ts", () => ({
  runAgentLoop: vi.fn().mockResolvedValue("agent-reply"),
}));

const { mockRegistry } = vi.hoisted(() => {
  const mockRegistry = {
    definitions: [{ name: "mock_tool" }],
    execute: vi.fn(),
    isSuspending: vi.fn().mockReturnValue(false),
  };
  return { mockRegistry };
});

vi.mock("../agent/tools/index.ts", () => ({
  createToolRegistry: vi.fn().mockReturnValue(mockRegistry),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("skill file content"),
}));

import { runAgentLoop } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";
import { readFile } from "fs/promises";
import { registerSendMessage } from "./send-message.ts";
import { registerHandleMessage } from "./handle-message.ts";
import { registerExecuteSkill } from "./execute-skill.ts";
import { registerWorkflow } from "./workflow.ts";

// ---- Helpers ----

/** Minimal Absurd stub that captures registered task handlers. */
function makeAbsurd() {
  const handlers = new Map<string, Function>();
  return {
    handlers,
    registerTask(meta: { name: string }, handler: Function) {
      handlers.set(meta.name, handler);
    },
    // stubs for executor deps
    spawn: vi.fn(),
    cancelTask: vi.fn(),
    listSchedules: vi.fn(),
  };
}

function makeChannels() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn(),
    register: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  };
}

function makeConfig() {
  return {
    channels: [{ type: "telegram", token: "tg-token" }],
    anthropicApiKey: "sk-key",
    databaseUrl: "postgres://localhost/test",
    queueName: "test-queue",
    notesDir: "/tmp/notes",
    skillsDir: "/tmp/skills",
    toolsDir: "/tmp/tools",
    model: "claude-sonnet-4-5-20250929",
    maxHistoryMessages: 50,
    workerConcurrency: 1,
    claimTimeout: 30,
    scriptTimeout: 10,
  };
}

function makeDeps(overrides?: Record<string, any>) {
  return {
    anthropic: {} as any,
    pool: {} as any,
    channels: makeChannels() as any,
    config: makeConfig(),
    startedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeCtx(): any {
  return {
    step: vi.fn((_name: string, fn: Function) => fn()),
  };
}

// ---- Tests ----

describe("send-message", () => {
  it("registers a task named 'send-message'", () => {
    const absurd = makeAbsurd();
    const channels = makeChannels();
    registerSendMessage(absurd as any, channels as any);
    expect(absurd.handlers.has("send-message")).toBe(true);
  });

  it("calls channels.sendMessage with recipientId and text", async () => {
    const absurd = makeAbsurd();
    const channels = makeChannels();
    registerSendMessage(absurd as any, channels as any);

    const handler = absurd.handlers.get("send-message")!;
    const result = await handler({ recipientId: "telegram:42", text: "hello" }, makeCtx());

    expect(channels.sendMessage).toHaveBeenCalledOnce();
    expect(channels.sendMessage).toHaveBeenCalledWith("telegram:42", "hello");
    expect(result).toEqual({ sent: true });
  });

  it("propagates channel send errors", async () => {
    const absurd = makeAbsurd();
    const channels = makeChannels();
    channels.sendMessage.mockRejectedValue(new Error("network"));
    registerSendMessage(absurd as any, channels as any);

    const handler = absurd.handlers.get("send-message")!;
    await expect(handler({ recipientId: "telegram:1", text: "x" }, makeCtx())).rejects.toThrow(
      "network",
    );
  });
});

describe("handle-message", () => {
  beforeEach(() => {
    vi.mocked(runAgentLoop).mockReset().mockResolvedValue("agent-reply");
    vi.mocked(createToolRegistry).mockReset().mockReturnValue(mockRegistry as any);
  });

  it("registers a task named 'handle-message'", () => {
    const absurd = makeAbsurd();
    registerHandleMessage(absurd as any, makeDeps());
    expect(absurd.handlers.has("handle-message")).toBe(true);
  });

  it("creates registry with correct deps", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerHandleMessage(absurd as any, deps);

    const handler = absurd.handlers.get("handle-message")!;
    await handler({ recipientId: "telegram:99", text: "hi" }, ctx);

    expect(createToolRegistry).toHaveBeenCalledOnce();
    expect(createToolRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        absurd,
        pool: deps.pool,
        ctx,
        queueName: deps.config.queueName,
        recipientId: "telegram:99",
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        scriptTimeout: deps.config.scriptTimeout,
        startedAt: deps.startedAt,
      }),
    );
  });

  it("calls runAgentLoop with correct params", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerHandleMessage(absurd as any, deps);

    const handler = absurd.handlers.get("handle-message")!;
    await handler({ recipientId: "telegram:99", text: "hi" }, ctx);

    expect(runAgentLoop).toHaveBeenCalledOnce();
    expect(runAgentLoop).toHaveBeenCalledWith(ctx, "telegram:99", "hi", {
      anthropic: deps.anthropic,
      pool: deps.pool,
      model: deps.config.model,
      dirs: {
        notes: deps.config.notesDir,
        skills: deps.config.skillsDir,
        tools: deps.config.toolsDir,
      },
      maxHistory: deps.config.maxHistoryMessages,
      registry: mockRegistry,
      onText: expect.any(Function),
      log: undefined,
    });
  });

  it("returns the agent reply", async () => {
    const absurd = makeAbsurd();
    registerHandleMessage(absurd as any, makeDeps());

    const handler = absurd.handlers.get("handle-message")!;
    const result = await handler({ recipientId: "telegram:1", text: "test" }, makeCtx());

    expect(result).toEqual({ reply: "agent-reply" });
  });

  it("onText sends a message to the right recipientId", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    registerHandleMessage(absurd as any, deps);

    const handler = absurd.handlers.get("handle-message")!;
    await handler({ recipientId: "telegram:77", text: "test" }, makeCtx());

    // Extract the onText callback that was passed to runAgentLoop
    const opts = vi.mocked(runAgentLoop).mock.calls[0][3];
    // Invoke onText
    opts.onText!("reply text");
    expect(deps.channels.sendMessage).toHaveBeenCalledWith("telegram:77", "reply text");
  });

  it("onText swallows send errors", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    deps.channels.sendMessage.mockReturnValue(Promise.reject(new Error("net")));
    registerHandleMessage(absurd as any, deps);

    const handler = absurd.handlers.get("handle-message")!;
    await handler({ recipientId: "telegram:1", text: "x" }, makeCtx());

    const opts = vi.mocked(runAgentLoop).mock.calls[0][3];
    // Should not throw
    expect(() => opts.onText!("y")).not.toThrow();
  });
});

describe("execute-skill", () => {
  beforeEach(() => {
    vi.mocked(runAgentLoop).mockReset().mockResolvedValue("skill-reply");
    vi.mocked(createToolRegistry).mockReset().mockReturnValue(mockRegistry as any);
    vi.mocked(readFile).mockReset().mockResolvedValue("skill file content" as any);
  });

  it("registers a task named 'execute-skill'", () => {
    const absurd = makeAbsurd();
    registerExecuteSkill(absurd as any, makeDeps());
    expect(absurd.handlers.has("execute-skill")).toBe(true);
  });

  it("reads skill file via ctx.step", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerExecuteSkill(absurd as any, deps);

    const handler = absurd.handlers.get("execute-skill")!;
    await handler({ skillName: "morning-check", recipientId: "telegram:10" }, ctx);

    // ctx.step should have been called with "read-skill"
    expect(ctx.step).toHaveBeenCalledWith("read-skill", expect.any(Function));

    // readFile should be called with the resolved skill path
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining("morning-check.md"),
      "utf-8",
    );
  });

  it("calls runAgentLoop with skill content as message", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    registerExecuteSkill(absurd as any, deps);

    const handler = absurd.handlers.get("execute-skill")!;
    await handler({ skillName: "test-skill", recipientId: "telegram:10" }, makeCtx());

    expect(runAgentLoop).toHaveBeenCalledOnce();
    expect(runAgentLoop).toHaveBeenCalledWith(
      expect.anything(),
      "telegram:10",
      "Execute the following skill instructions:\n\nskill file content",
      expect.objectContaining({
        maxHistory: 10,
      }),
    );
  });

  it("creates registry with recipientId from params", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerExecuteSkill(absurd as any, deps);

    const handler = absurd.handlers.get("execute-skill")!;
    await handler({ skillName: "foo", recipientId: "telegram:55" }, ctx);

    expect(createToolRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: "telegram:55",
        ctx,
      }),
    );
  });

  it("returns skillName and reply", async () => {
    const absurd = makeAbsurd();
    registerExecuteSkill(absurd as any, makeDeps());

    const handler = absurd.handlers.get("execute-skill")!;
    const result = await handler(
      { skillName: "daily", recipientId: "telegram:1" },
      makeCtx(),
    );

    expect(result).toEqual({ skillName: "daily", reply: "skill-reply" });
  });

  it("rejects path traversal in skill name", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    // Use a skillsDir that does NOT contain the traversed path
    deps.config.skillsDir = "/tmp/skills";
    registerExecuteSkill(absurd as any, deps);

    const handler = absurd.handlers.get("execute-skill")!;
    await expect(
      handler({ skillName: "../../etc/passwd", recipientId: "telegram:1" }, makeCtx()),
    ).rejects.toThrow("Invalid skill name");
  });

  it("onText sends message for the correct recipientId", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    registerExecuteSkill(absurd as any, deps);

    const handler = absurd.handlers.get("execute-skill")!;
    await handler({ skillName: "test", recipientId: "telegram:88" }, makeCtx());

    const opts = vi.mocked(runAgentLoop).mock.calls[0][3];
    opts.onText!("some text");
    expect(deps.channels.sendMessage).toHaveBeenCalledWith("telegram:88", "some text");
  });
});

describe("workflow", () => {
  beforeEach(() => {
    vi.mocked(runAgentLoop).mockReset().mockResolvedValue("workflow-reply");
    vi.mocked(createToolRegistry).mockReset().mockReturnValue(mockRegistry as any);
  });

  it("registers a task named 'workflow'", () => {
    const absurd = makeAbsurd();
    registerWorkflow(absurd as any, makeDeps());
    expect(absurd.handlers.has("workflow")).toBe(true);
  });

  it("passes instructions to runAgentLoop when no context", async () => {
    const absurd = makeAbsurd();
    registerWorkflow(absurd as any, makeDeps());

    const handler = absurd.handlers.get("workflow")!;
    await handler(
      { recipientId: "telegram:1", instructions: "do the thing" },
      makeCtx(),
    );

    expect(runAgentLoop).toHaveBeenCalledOnce();
    expect(runAgentLoop).toHaveBeenCalledWith(
      expect.anything(),
      "telegram:1",
      "do the thing",
      expect.objectContaining({
        maxHistory: 10,
      }),
    );
  });

  it("includes context prefix when params.context is provided", async () => {
    const absurd = makeAbsurd();
    registerWorkflow(absurd as any, makeDeps());

    const handler = absurd.handlers.get("workflow")!;
    await handler(
      { recipientId: "telegram:2", instructions: "run it", context: { key: "val" } },
      makeCtx(),
    );

    expect(runAgentLoop).toHaveBeenCalledWith(
      expect.anything(),
      "telegram:2",
      'Context: {"key":"val"}\n\nrun it',
      expect.anything(),
    );
  });

  it("does not add context prefix when context is undefined", async () => {
    const absurd = makeAbsurd();
    registerWorkflow(absurd as any, makeDeps());

    const handler = absurd.handlers.get("workflow")!;
    await handler({ recipientId: "telegram:1", instructions: "hello" }, makeCtx());

    const message = vi.mocked(runAgentLoop).mock.calls[0][2];
    expect(message).toBe("hello");
    expect(message).not.toContain("Context:");
  });

  it("does not add context prefix when context is null/falsy", async () => {
    const absurd = makeAbsurd();
    registerWorkflow(absurd as any, makeDeps());

    const handler = absurd.handlers.get("workflow")!;
    await handler(
      { recipientId: "telegram:1", instructions: "go", context: null },
      makeCtx(),
    );

    const message = vi.mocked(runAgentLoop).mock.calls[0][2];
    expect(message).toBe("go");
  });

  it("creates registry with correct deps", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerWorkflow(absurd as any, deps);

    const handler = absurd.handlers.get("workflow")!;
    await handler({ recipientId: "telegram:33", instructions: "x" }, ctx);

    expect(createToolRegistry).toHaveBeenCalledOnce();
    expect(createToolRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        absurd,
        pool: deps.pool,
        ctx,
        queueName: deps.config.queueName,
        recipientId: "telegram:33",
        notesDir: deps.config.notesDir,
        skillsDir: deps.config.skillsDir,
        toolsDir: deps.config.toolsDir,
        scriptTimeout: deps.config.scriptTimeout,
        startedAt: deps.startedAt,
      }),
    );
  });

  it("returns the reply", async () => {
    const absurd = makeAbsurd();
    registerWorkflow(absurd as any, makeDeps());

    const handler = absurd.handlers.get("workflow")!;
    const result = await handler(
      { recipientId: "telegram:1", instructions: "test" },
      makeCtx(),
    );

    expect(result).toEqual({ reply: "workflow-reply" });
  });

  it("onText sends message for the correct recipientId", async () => {
    const absurd = makeAbsurd();
    const deps = makeDeps();
    registerWorkflow(absurd as any, deps);

    const handler = absurd.handlers.get("workflow")!;
    await handler({ recipientId: "telegram:44", instructions: "do" }, makeCtx());

    const opts = vi.mocked(runAgentLoop).mock.calls[0][3];
    opts.onText!("workflow text");
    expect(deps.channels.sendMessage).toHaveBeenCalledWith("telegram:44", "workflow text");
  });
});
