import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Absurd } from "absurd-sdk";
import { createBot } from "./bot.ts";

// ---------------------------------------------------------------------------
// Mock grammy so we never hit the Telegram API.  We capture the handler
// registered via `bot.on("message:text", handler)` so we can invoke it
// directly with a fake context.
// ---------------------------------------------------------------------------

type Handler = (ctx: any) => Promise<void>;
let capturedHandler: Handler | undefined;

vi.mock("grammy", () => {
  class Bot {
    token: string;
    constructor(token: string) {
      this.token = token;
    }
    on(_filter: string, handler: Handler) {
      capturedHandler = handler;
    }
  }
  return { Bot };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(chatId: number, text: string) {
  return {
    chat: { id: chatId },
    message: { text },
  };
}

function makeMockAbsurd(): Absurd {
  return {
    spawn: vi.fn().mockResolvedValue({ taskID: "t1", runID: "r1", attempt: 1, created: true }),
  } as unknown as Absurd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBot", () => {
  let absurd: Absurd;

  beforeEach(() => {
    capturedHandler = undefined;
    absurd = makeMockAbsurd();
  });

  // --- 1. createBot returns a Bot instance ---
  it("returns a Bot instance with the given token", () => {
    const bot = createBot("test-token", absurd);
    expect(bot).toBeDefined();
    expect((bot as any).token).toBe("test-token");
  });

  it("registers a message:text handler", () => {
    createBot("tok", absurd);
    expect(capturedHandler).toBeTypeOf("function");
  });

  // --- 2. onFirstMessage fires on first message ---
  it("calls onFirstMessage with the chat id on the first message", async () => {
    const onFirstMessage = vi.fn().mockResolvedValue(undefined);
    createBot("tok", absurd, { onFirstMessage });

    await capturedHandler!(makeCtx(42, "hello"));

    expect(onFirstMessage).toHaveBeenCalledOnce();
    expect(onFirstMessage).toHaveBeenCalledWith(42);
  });

  // --- 3. onFirstMessage fires only once ---
  it("calls onFirstMessage only once across multiple messages", async () => {
    const onFirstMessage = vi.fn().mockResolvedValue(undefined);
    createBot("tok", absurd, { onFirstMessage });

    await capturedHandler!(makeCtx(1, "first"));
    await capturedHandler!(makeCtx(1, "second"));
    await capturedHandler!(makeCtx(2, "third"));

    expect(onFirstMessage).toHaveBeenCalledOnce();
    expect(onFirstMessage).toHaveBeenCalledWith(1);
  });

  // --- 4. Race condition fix: callback is nullified synchronously before await ---
  it("fires onFirstMessage only once even when two messages arrive concurrently", async () => {
    // The callback includes a delay to simulate async work.  If the code
    // did NOT nullify the reference synchronously (before the await), both
    // concurrent invocations would see the callback as still set.
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => { resolveFirst = r; });

    const onFirstMessage = vi.fn().mockReturnValue(gate);
    createBot("tok", absurd, { onFirstMessage });

    // Fire two messages without awaiting the first
    const p1 = capturedHandler!(makeCtx(1, "a"));
    const p2 = capturedHandler!(makeCtx(2, "b"));

    // Unblock the callback so both promises can settle
    resolveFirst();
    await Promise.all([p1, p2]);

    // The key assertion: even though both started before the first
    // callback resolved, the callback was only invoked once.
    expect(onFirstMessage).toHaveBeenCalledOnce();
  });

  // --- 5. Each message spawns a handle-message task ---
  it("spawns a handle-message task with chatId and text", async () => {
    createBot("tok", absurd);

    await capturedHandler!(makeCtx(99, "ping"));

    expect(absurd.spawn).toHaveBeenCalledOnce();
    expect(absurd.spawn).toHaveBeenCalledWith("handle-message", {
      chatId: 99,
      text: "ping",
    });
  });

  it("spawns a task for every message received", async () => {
    createBot("tok", absurd);

    await capturedHandler!(makeCtx(1, "one"));
    await capturedHandler!(makeCtx(2, "two"));
    await capturedHandler!(makeCtx(3, "three"));

    expect(absurd.spawn).toHaveBeenCalledTimes(3);
    expect(absurd.spawn).toHaveBeenNthCalledWith(1, "handle-message", { chatId: 1, text: "one" });
    expect(absurd.spawn).toHaveBeenNthCalledWith(2, "handle-message", { chatId: 2, text: "two" });
    expect(absurd.spawn).toHaveBeenNthCalledWith(3, "handle-message", { chatId: 3, text: "three" });
  });

  it("spawns the task after the onFirstMessage callback resolves", async () => {
    const callOrder: string[] = [];
    const onFirstMessage = vi.fn().mockImplementation(async () => {
      callOrder.push("onFirstMessage");
    });
    (absurd.spawn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("spawn");
      return { taskID: "t1", runID: "r1", attempt: 1, created: true };
    });

    createBot("tok", absurd, { onFirstMessage });
    await capturedHandler!(makeCtx(1, "hi"));

    expect(callOrder).toEqual(["onFirstMessage", "spawn"]);
  });

  // --- 6. No onFirstMessage: messages still spawn tasks ---
  it("spawns tasks normally when no onFirstMessage is provided", async () => {
    createBot("tok", absurd);

    await capturedHandler!(makeCtx(10, "test"));

    expect(absurd.spawn).toHaveBeenCalledOnce();
    expect(absurd.spawn).toHaveBeenCalledWith("handle-message", {
      chatId: 10,
      text: "test",
    });
  });

  it("spawns tasks normally when opts is undefined", async () => {
    createBot("tok", absurd, undefined);

    await capturedHandler!(makeCtx(5, "msg"));

    expect(absurd.spawn).toHaveBeenCalledOnce();
    expect(absurd.spawn).toHaveBeenCalledWith("handle-message", {
      chatId: 5,
      text: "msg",
    });
  });

  it("spawns tasks normally when opts is empty object", async () => {
    createBot("tok", absurd, {});

    await capturedHandler!(makeCtx(7, "empty"));

    expect(absurd.spawn).toHaveBeenCalledOnce();
    expect(absurd.spawn).toHaveBeenCalledWith("handle-message", {
      chatId: 7,
      text: "empty",
    });
  });
});
