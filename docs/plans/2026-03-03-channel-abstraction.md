# Channel Abstraction Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decouple Telegram from everclaw's core via a `ChannelAdapter` interface, `ChannelRegistry`, and prefixed string recipient IDs, enabling future multi-channel support.

**Architecture:** Thin adapter pattern inspired by NanoClaw. Each channel implements a `ChannelAdapter` interface (start/sendMessage/stop). A `ChannelRegistry` routes messages by recipient ID prefix (e.g. `telegram:123`). Database `chat_id` migrates from integer to text.

**Tech Stack:** TypeScript, grammY (Telegram adapter), pg (Postgres), vitest (tests)

---

### Task 1: Create `splitMessage` utility with tests

Extract the existing `splitForTelegram` logic from `src/tasks/shared.ts` into a generic, reusable utility.

**Files:**
- Create: `src/channels/split.ts`
- Create: `src/channels/split.test.ts`

**Step 1: Write the failing tests**

Create `src/channels/split.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { splitMessage } from "./split.ts";

describe("splitMessage", () => {
  it("returns text as-is when under the limit", () => {
    expect(splitMessage("short", 100)).toEqual(["short"]);
  });

  it("returns text as-is when exactly at the limit", () => {
    const text = "a".repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });

  it("splits at paragraph boundary when possible", () => {
    const text = "a".repeat(50) + "\n\n" + "b".repeat(60);
    const chunks = splitMessage(text, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(60));
  });

  it("falls back to line boundary when no paragraph break", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(60);
    const chunks = splitMessage(text, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(60));
  });

  it("hard-splits when no newlines available", () => {
    const text = "a".repeat(200);
    const chunks = splitMessage(text, 80);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("a".repeat(80));
    expect(chunks[1]).toBe("a".repeat(80));
    expect(chunks[2]).toBe("a".repeat(40));
  });

  it("strips leading newlines from subsequent chunks", () => {
    const text = "a".repeat(50) + "\n\n\n" + "b".repeat(30);
    const chunks = splitMessage(text, 60);
    expect(chunks[1]).toBe("b".repeat(30));
    expect(chunks[1]).not.toMatch(/^\n/);
  });

  it("handles empty string", () => {
    expect(splitMessage("", 100)).toEqual([""]);
  });

  it("works with Telegram's 4096 limit", () => {
    const text = "x".repeat(5000);
    const chunks = splitMessage(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(904);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/channels/split.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/channels/split.ts`:

```typescript
/** Split text into chunks that fit within a character limit.
 *  Prefers paragraph boundaries (\n\n), then line boundaries (\n), then hard-splits. */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test src/channels/split.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add src/channels/split.ts src/channels/split.test.ts
git commit -m "feat: add generic splitMessage utility for channel adapters"
```

---

### Task 2: Create `ChannelAdapter` interface and `ChannelRegistry`

**Files:**
- Create: `src/channels/adapter.ts`
- Create: `src/channels/registry.ts`
- Create: `src/channels/registry.test.ts`

**Step 1: Write the interface**

Create `src/channels/adapter.ts`:

```typescript
export interface InboundMessage {
  recipientId: string;
  text: string;
}

export interface ChannelAdapter {
  /** Channel name, used as recipientId prefix (e.g. "telegram") */
  name: string;
  /** Max characters per message for this platform */
  maxMessageLength: number;
  /** Start listening. Calls onMessage for each inbound user message. */
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** Send a text message to a recipient. Adapter handles splitting internally. */
  sendMessage(recipientId: string, text: string): Promise<void>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}
```

**Step 2: Write failing registry tests**

Create `src/channels/registry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ChannelRegistry } from "./registry.ts";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";

function fakeAdapter(name: string): ChannelAdapter {
  return {
    name,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ChannelRegistry", () => {
  it("resolves adapter by recipientId prefix", () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    registry.register(tg);
    expect(registry.resolve("telegram:123")).toBe(tg);
  });

  it("throws for unknown prefix", () => {
    const registry = new ChannelRegistry();
    expect(() => registry.resolve("whatsapp:123")).toThrow('No channel adapter for prefix "whatsapp"');
  });

  it("routes sendMessage to the correct adapter", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    const slack = fakeAdapter("slack");
    registry.register(tg);
    registry.register(slack);

    await registry.sendMessage("slack:C04", "hello");

    expect(slack.sendMessage).toHaveBeenCalledWith("slack:C04", "hello");
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("startAll starts all adapters with the same onMessage callback", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    const slack = fakeAdapter("slack");
    registry.register(tg);
    registry.register(slack);

    const onMessage = vi.fn();
    await registry.startAll(onMessage);

    expect(tg.start).toHaveBeenCalledWith(onMessage);
    expect(slack.start).toHaveBeenCalledWith(onMessage);
  });

  it("stopAll stops all adapters", async () => {
    const registry = new ChannelRegistry();
    const tg = fakeAdapter("telegram");
    registry.register(tg);

    await registry.stopAll();

    expect(tg.stop).toHaveBeenCalledOnce();
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `pnpm test src/channels/registry.test.ts`
Expected: FAIL — module not found

**Step 4: Write the registry implementation**

Create `src/channels/registry.ts`:

```typescript
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";

export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  resolve(recipientId: string): ChannelAdapter {
    const prefix = recipientId.split(":")[0];
    const adapter = this.adapters.get(prefix);
    if (!adapter) throw new Error(`No channel adapter for prefix "${prefix}"`);
    return adapter;
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const adapter = this.resolve(recipientId);
    await adapter.sendMessage(recipientId, text);
  }

  async startAll(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start(onMessage);
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `pnpm test src/channels/registry.test.ts`
Expected: All 5 tests PASS

**Step 6: Commit**

```bash
git add src/channels/adapter.ts src/channels/registry.ts src/channels/registry.test.ts
git commit -m "feat: add ChannelAdapter interface and ChannelRegistry"
```

---

### Task 3: Create `TelegramAdapter`

**Files:**
- Create: `src/channels/telegram.ts`
- Create: `src/channels/telegram.test.ts`

**Step 1: Write failing tests**

Create `src/channels/telegram.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./adapter.ts";

// Mock grammy
type Handler = (ctx: any) => Promise<void>;
let capturedHandler: Handler | undefined;
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();

vi.mock("grammy", () => {
  class Bot {
    token: string;
    api = { sendMessage: mockSendMessage };
    constructor(token: string) { this.token = token; }
    on(_filter: string, handler: Handler) { capturedHandler = handler; }
    start(_opts?: any) {}
    stop() { mockStop(); }
  }
  return { Bot };
});

import { TelegramAdapter } from "./telegram.ts";

function makeGrammyCtx(chatId: number, text: string) {
  return { chat: { id: chatId }, message: { text } };
}

describe("TelegramAdapter", () => {
  beforeEach(() => {
    capturedHandler = undefined;
    mockSendMessage.mockClear();
    mockStop.mockClear();
  });

  it("has name 'telegram' and maxMessageLength 4096", () => {
    const adapter = new TelegramAdapter("token");
    expect(adapter.name).toBe("telegram");
    expect(adapter.maxMessageLength).toBe(4096);
  });

  it("start registers a message handler and calls onMessage with prefixed recipientId", async () => {
    const adapter = new TelegramAdapter("token");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    expect(capturedHandler).toBeDefined();

    await capturedHandler!(makeGrammyCtx(601870898, "hello"));

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({
      recipientId: "telegram:601870898",
      text: "hello",
    });
  });

  it("sendMessage parses recipientId and calls bot.api.sendMessage", async () => {
    const adapter = new TelegramAdapter("token");
    await adapter.sendMessage("telegram:42", "hi");

    expect(mockSendMessage).toHaveBeenCalledWith(42, "hi");
  });

  it("sendMessage splits long messages", async () => {
    const adapter = new TelegramAdapter("token");
    const longText = "a".repeat(5000);

    await adapter.sendMessage("telegram:1", longText);

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[0][1]).toHaveLength(4096);
    expect(mockSendMessage.mock.calls[1][1]).toHaveLength(904);
  });

  it("stop calls bot.stop()", async () => {
    const adapter = new TelegramAdapter("token");
    await adapter.stop();
    expect(mockStop).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/channels/telegram.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/channels/telegram.ts`:

```typescript
import { Bot } from "grammy";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";
import { splitMessage } from "./split.ts";

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram" as const;
  maxMessageLength = 4096;
  private bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.bot.on("message:text", async (ctx) => {
      await onMessage({
        recipientId: `telegram:${ctx.chat.id}`,
        text: ctx.message.text,
      });
    });
    this.bot.start({ onStart: () => {} });
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    const chatId = Number(recipientId.replace("telegram:", ""));
    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
  }

  async stop(): Promise<void> {
    this.bot.stop();
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test src/channels/telegram.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat: add TelegramAdapter implementing ChannelAdapter"
```

---

### Task 4: Create barrel export for channels module

**Files:**
- Create: `src/channels/index.ts`

**Step 1: Create the barrel file**

Create `src/channels/index.ts`:

```typescript
export type { ChannelAdapter, InboundMessage } from "./adapter.ts";
export { ChannelRegistry } from "./registry.ts";
export { TelegramAdapter } from "./telegram.ts";
export { splitMessage } from "./split.ts";
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/channels/index.ts
git commit -m "feat: add channels module barrel export"
```

---

### Task 5: Migrate `chatId: number` to `recipientId: string` in history layer

**Files:**
- Modify: `src/memory/history.ts`
- Modify: `src/memory/history.test.ts`

**Step 1: Update history.ts**

In `src/memory/history.ts`, make these changes:

1. Rename `chatId: number` to `recipientId: string` in `BaseMessage` (line 6)
2. Update `appendMessage` to use `msg.recipientId` (line 30)
3. Update `getRecentMessages` signature: `chatId: number` → `recipientId: string` (line 37)
4. Update row mapping: `chatId: r.chat_id` → `recipientId: r.chat_id` (line 46)

The resulting file:

```typescript
// src/memory/history.ts
import type { Pool } from "pg";

export interface BaseMessage {
  id?: number;
  recipientId: string;
  content: string;
  createdAt?: Date;
}

export interface UserMessage extends BaseMessage {
  role: "user";
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  toolUse?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

export interface ToolResultMessage extends BaseMessage {
  role: "tool";
  toolUse: Array<{ tool_use_id: string; content: string }>;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export async function appendMessage(pool: Pool, msg: Message): Promise<void> {
  const toolUse = msg.role === "assistant" || msg.role === "tool" ? msg.toolUse : undefined;
  await pool.query(
    `INSERT INTO assistant.messages (chat_id, role, content, tool_use)
     VALUES ($1, $2, $3, $4)`,
    [msg.recipientId, msg.role, msg.content, toolUse ? JSON.stringify(toolUse) : null],
  );
}

export async function getRecentMessages(
  pool: Pool, recipientId: string, limit: number = 50,
): Promise<Message[]> {
  const result = await pool.query(
    `SELECT id, chat_id, role, content, tool_use, created_at
     FROM assistant.messages WHERE chat_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [recipientId, limit],
  );
  return result.rows.reverse().map((r): Message => {
    const base = { id: r.id, recipientId: r.chat_id as string, content: r.content, createdAt: r.created_at };
    if (r.role === "tool") return { ...base, role: "tool", toolUse: r.tool_use ?? [] };
    if (r.role === "assistant") return { ...base, role: "assistant", toolUse: r.tool_use ?? undefined };
    return { ...base, role: "user" };
  });
}
```

**Step 2: Update history.test.ts**

Replace all `chatId: <number>` with `recipientId: "<string>"` in test fixtures. For example:
- `chatId: 42` → `recipientId: "telegram:42"`
- `chatId: 1` → `recipientId: "telegram:1"`
- `chatId: 7` → `recipientId: "telegram:7"`
- `chatId: 5` → `recipientId: "telegram:5"`
- `chatId: 3` → `recipientId: "telegram:3"`
- `chatId: 99` → `recipientId: "telegram:99"`

In the `appendMessage` test, update the expected params:
- `[42, "user", "hello world", null]` → `["telegram:42", "user", "hello world", null]`

In the `getRecentMessages` row mapping test, update expectations:
- `chatId: 5` → `recipientId: "telegram:5"` (pass `"telegram:5"` to the function call, and set `chat_id: "telegram:5"` in mock rows)

In `getRecentMessages` calls: `await getRecentMessages(pool, 7)` → `await getRecentMessages(pool, "telegram:7")`

**Step 3: Run tests to verify they pass**

Run: `pnpm test src/memory/history.test.ts`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/memory/history.ts src/memory/history.test.ts
git commit -m "refactor: rename chatId to recipientId in history layer"
```

---

### Task 6: Migrate `chatId` to `recipientId` in agent layer

**Files:**
- Modify: `src/agent/loop.ts` — `chatId: number` → `recipientId: string` in `runAgentLoop` signature (line 58) and all usages
- Modify: `src/agent/tools/types.ts` — `ExecutorDeps.chatId: number` → `recipientId: string` (line 12)
- Modify: `src/agent/tools/orchestration.ts` — `deps.chatId` → `deps.recipientId` in spawn_task (line 41)
- Modify: `src/memory/messages.ts` — `deconstructMessages(chatId: number, ...)` → `deconstructMessages(recipientId: string, ...)`
- Modify: `src/agent/loop.test.ts` — all `chatId` references in test calls and assertions
- Modify: `src/memory/messages.test.ts` — if it references chatId

**Step 1: Update types.ts**

In `src/agent/tools/types.ts` line 12, change:
```
chatId: number;
```
to:
```
recipientId: string;
```

**Step 2: Update orchestration.ts**

In `src/agent/tools/orchestration.ts` lines 40-42, change:
```typescript
if (params.chatId === "current" || params.chatId == null) {
  params.chatId = deps.chatId;
}
```
to:
```typescript
if (params.recipientId === "current" || params.recipientId == null) {
  params.recipientId = deps.recipientId;
}
```

**Step 3: Update loop.ts**

In `src/agent/loop.ts`:
- Line 58: `chatId: number` → `recipientId: string`
- Line 67: `getRecentMessages(deps.pool, chatId, ...)` → `getRecentMessages(deps.pool, recipientId, ...)`
- Line 160: `appendMessage(deps.pool, { chatId, role: "user", ... })` → `appendMessage(deps.pool, { recipientId, role: "user", ... })`
- Line 162: `deconstructMessages(chatId, ...)` → `deconstructMessages(recipientId, ...)`

**Step 4: Update messages.ts**

In `src/memory/messages.ts`, update `deconstructMessages` signature:
- `chatId: number` → `recipientId: string`
- All internal `chatId` usages → `recipientId`

**Step 5: Update loop.test.ts**

Replace all numeric chatId arguments in `runAgentLoop` calls with string recipientIds:
- `await runAgentLoop(ctx, 1, "hi", deps)` → `await runAgentLoop(ctx, "telegram:1", "hi", deps)`
- `await runAgentLoop(ctx, 42, "user-msg", deps)` → `await runAgentLoop(ctx, "telegram:42", "user-msg", deps)`
- `await runAgentLoop(ctx, 99, "hi", deps)` → `await runAgentLoop(ctx, "telegram:99", "hi", deps)`

Update all assertion `chatId` references:
- `chatId: 42` → `recipientId: "telegram:42"`
- etc.

Also in `getRecentMessages` mock return values:
- `chatId: 1` → `recipientId: "telegram:1"` (in history mock data)

**Step 6: Update messages.test.ts if needed**

Check if `messages.test.ts` uses `chatId` — if so, update to `recipientId`.

**Step 7: Run tests**

Run: `pnpm test src/agent/ src/memory/`
Expected: All tests PASS

**Step 8: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors (this may surface remaining chatId references elsewhere — fix them)

**Step 9: Commit**

```bash
git add src/agent/ src/memory/
git commit -m "refactor: rename chatId to recipientId in agent and memory layers"
```

---

### Task 7: Migrate task handlers to use `recipientId` and `ChannelRegistry`

**Files:**
- Modify: `src/tasks/shared.ts` — replace `Bot` with `ChannelRegistry`, `chatId` → `recipientId`
- Modify: `src/tasks/handle-message.ts` — `chatId: number` → `recipientId: string`
- Modify: `src/tasks/execute-skill.ts` — `chatId: number` → `recipientId: string`
- Modify: `src/tasks/workflow.ts` — `chatId: number` → `recipientId: string`, fix `context?: any`
- Modify: `src/tasks/send-message.ts` — use `ChannelRegistry` instead of `Bot`
- Modify: `src/tasks/tasks.test.ts` — update all test helpers and assertions

**Step 1: Update shared.ts**

In `src/tasks/shared.ts`:

1. Remove `import type { Bot } from "grammy"` (line 5)
2. Add `import { ChannelRegistry } from "../channels/index.ts"`
3. Remove the `splitForTelegram` function and `TG_MAX` constant (lines 11-34)
4. In `TaskDeps` interface: replace `bot: Bot` with `channels: ChannelRegistry`
5. In `buildAgentDeps`: change `chatId: number` param to `recipientId: string`
6. Update `createToolRegistry` call: `chatId` → `recipientId`
7. Update `onText` callback:

```typescript
onText: opts?.silent ? undefined : (text) => {
  deps.channels.sendMessage(recipientId, text).catch(() => {});
},
```

**Step 2: Update handle-message.ts**

Change `params: { chatId: number; text: string }` → `params: { recipientId: string; text: string }` and update all `params.chatId` → `params.recipientId`.

**Step 3: Update execute-skill.ts**

Change `params: { skillName: string; chatId: number }` → `params: { skillName: string; recipientId: string }` and update all `params.chatId` → `params.recipientId`.

**Step 4: Update workflow.ts**

Change `params: { chatId: number; instructions: string; context?: any }` → `params: { recipientId: string; instructions: string; context?: unknown }` and update all `params.chatId` → `params.recipientId`.

**Step 5: Update send-message.ts**

Replace `Bot` import with `ChannelRegistry`:

```typescript
import type { Absurd, TaskContext } from "absurd-sdk";
import type { ChannelRegistry } from "../channels/index.ts";

export function registerSendMessage(absurd: Absurd, channels: ChannelRegistry): void {
  absurd.registerTask(
    { name: "send-message" },
    async (params: { recipientId: string; text: string }, _ctx: TaskContext) => {
      await channels.sendMessage(params.recipientId, params.text);
      return { sent: true };
    },
  );
}
```

**Step 6: Update tasks.test.ts**

Major changes:
1. Replace `makeBot()` helper with `makeChannels()`:
   ```typescript
   function makeChannels() {
     const sendMessage = vi.fn().mockResolvedValue(undefined);
     return { sendMessage, resolve: vi.fn(), register: vi.fn(), startAll: vi.fn(), stopAll: vi.fn() };
   }
   ```
2. In `makeDeps()`: replace `bot: makeBot()` with `channels: makeChannels()`
3. In `makeConfig()`: remove `telegramToken`
4. All `chatId: <number>` in params → `recipientId: "<string>"`
5. All `chatId: <number>` in `createToolRegistry` expectations → `recipientId: "<string>"`
6. All `runAgentLoop` call expectations: second arg from number to string
7. `send-message` tests: use `channels.sendMessage` instead of `bot.api.sendMessage`
8. `onText` tests: verify `deps.channels.sendMessage` called instead of `deps.bot.api.sendMessage`

**Step 7: Run tests**

Run: `pnpm test src/tasks/`
Expected: All tests PASS

**Step 8: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 9: Commit**

```bash
git add src/tasks/
git commit -m "refactor: migrate task handlers to ChannelRegistry and recipientId"
```

---

### Task 8: Update config and entry point

**Files:**
- Modify: `src/config.ts` — replace `telegramToken` with `channels` array
- Modify: `src/config.test.ts`
- Modify: `src/index.ts` — wire `ChannelRegistry` and `TelegramAdapter`
- Delete: `src/bot.ts`
- Delete: `src/bot.test.ts`

**Step 1: Update config.ts**

Add `ChannelConfig` type and replace `telegramToken`:

```typescript
export interface ChannelConfig {
  type: string;
  token: string;
}

export interface Config {
  channels: ChannelConfig[];
  anthropicApiKey: string;
  // ... rest unchanged (remove telegramToken)
}
```

In `loadConfig`, replace:
```typescript
telegramToken: requireSecret("TELEGRAM_BOT_TOKEN"),
```
with:
```typescript
channels: [{ type: "telegram", token: requireSecret("TELEGRAM_BOT_TOKEN") }],
```

**Step 2: Update config.test.ts**

- Remove `telegramToken` assertions
- Add assertion for `channels`:
  ```typescript
  expect(c.channels).toEqual([{ type: "telegram", token: "tg" }]);
  ```
- The "throws if missing" test still works — TELEGRAM_BOT_TOKEN is still required

**Step 3: Update index.ts**

Replace `createBot` usage with `ChannelRegistry` + `TelegramAdapter`:

```typescript
import { ChannelRegistry, TelegramAdapter } from "./channels/index.ts";

// Replace createBot block with:
const channelRegistry = new ChannelRegistry();
for (const ch of config.channels) {
  if (ch.type === "telegram") {
    channelRegistry.register(new TelegramAdapter(ch.token));
  }
}

// Update defaultChatId → defaultRecipientId (string)
let defaultRecipientId = ((await getState(pool, "system", "defaultRecipientId")) ?? "") as string;

const taskDeps = { anthropic, pool, channels: channelRegistry, config, startedAt, log: logger };
registerHandleMessage(absurd, taskDeps);
registerExecuteSkill(absurd, taskDeps);
registerSendMessage(absurd, channelRegistry);
registerWorkflow(absurd, taskDeps);

await syncSchedules(absurd, config.skillsDir, defaultRecipientId);

// Start channels with onMessage that captures first recipient
await channelRegistry.startAll(async (msg) => {
  if (!defaultRecipientId) {
    defaultRecipientId = msg.recipientId;
    await setState(pool, "system", "defaultRecipientId", msg.recipientId);
  }
  logger.info({ recipientId: msg.recipientId }, "message received");
  await absurd.spawn("handle-message", {
    recipientId: msg.recipientId,
    text: msg.text,
  });
});

// Shutdown: replace bot.stop() with channelRegistry.stopAll()
const shutdown = async () => {
  logger.info("shutting down");
  await channelRegistry.stopAll();
  await worker.close();
  await pool.end();
  process.exit(0);
};
```

**Step 4: Delete bot.ts and bot.test.ts**

Remove `src/bot.ts` and `src/bot.test.ts` — their functionality is now in `src/channels/telegram.ts`.

**Step 5: Update prompt.ts**

In `src/agent/prompt.ts` line 10, change:
```
You are a personal AI assistant communicating through Telegram.
```
to:
```
You are a personal AI assistant.
```

(The channel name doesn't need to be in the prompt — the agent doesn't need to know which channel it's on.)

**Step 6: Run all tests**

Run: `pnpm test`
Expected: All tests PASS (bot.test.ts should no longer run since the file is deleted)

**Step 7: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git rm src/bot.ts src/bot.test.ts
git add src/config.ts src/config.test.ts src/index.ts src/agent/prompt.ts
git commit -m "refactor: wire ChannelRegistry into entry point, remove bot.ts"
```

---

### Task 9: Update system integration tests

**Files:**
- Modify: `src/tasks/system.integration.test.ts`

**Step 1: Update test setup**

Replace `Bot` import and mock with `ChannelRegistry` mock:

```typescript
import { ChannelRegistry } from "../channels/index.ts";

// Replace makeBot block with:
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const channels = {
  sendMessage: mockSendMessage,
  resolve: vi.fn(),
  register: vi.fn(),
  startAll: vi.fn(),
  stopAll: vi.fn(),
} as unknown as ChannelRegistry;
```

Update `taskDeps`:
- Remove `bot` field
- Add `channels` field
- Remove `telegramToken` from config

Update `registerSendMessage` call:
- `registerSendMessage(db.absurd, bot)` → `registerSendMessage(db.absurd, channels)`

Update all spawn params:
- `chatId: 100001` → `recipientId: "telegram:100001"`

Update all assertions:
- `expect(sendMessageSpy).toHaveBeenCalledWith(chatId, text)` → `expect(mockSendMessage).toHaveBeenCalledWith("telegram:100001", text)`

Update history query assertions where `chat_id` is checked:
- The query `WHERE chat_id = $1` now receives a string, so `chatId.toString()` → `"telegram:100002"`

**Step 2: Run integration tests**

Run: `pnpm test src/tasks/system.integration.test.ts`
Expected: All 4 tests PASS

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/tasks/system.integration.test.ts
git commit -m "test: update system integration tests for channel abstraction"
```

---

### Task 10: Database migration script

**Files:**
- Create: `sql/003-channel-abstraction.sql`

**Step 1: Write the migration**

Create `sql/003-channel-abstraction.sql`:

```sql
-- Migrate chat_id from integer to text with channel prefix.
-- Existing rows get 'telegram:' prefix automatically.
ALTER TABLE assistant.messages
  ALTER COLUMN chat_id TYPE text USING 'telegram:' || chat_id;

-- Also migrate defaultChatId in state store to defaultRecipientId
UPDATE assistant.state
  SET key = 'defaultRecipientId',
      value = to_jsonb('telegram:' || (value #>> '{}'))
  WHERE namespace = 'system' AND key = 'defaultChatId';
```

**Step 2: Commit**

```bash
git add sql/003-channel-abstraction.sql
git commit -m "feat: add database migration for channel abstraction"
```

---

### Task 11: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update architecture section**

Add `channels/` to the file tree:
```
  channels/
    adapter.ts          ChannelAdapter interface & InboundMessage type
    registry.ts         ChannelRegistry: routes messages by recipientId prefix
    telegram.ts         TelegramAdapter: grammY-based Telegram implementation
    split.ts            Generic message splitting utility
    index.ts            Barrel export
```

Remove `bot.ts` from the tree.

Update the description of `index.ts`:
```
  index.ts              Entry point: creates Pool, Anthropic, Absurd, ChannelRegistry; registers tasks; starts worker
```

**Step 2: Update Key Patterns section**

Add a new pattern:
```
**Channel abstraction.** Messaging channels implement the `ChannelAdapter` interface (`start`, `sendMessage`, `stop`). A `ChannelRegistry` routes outbound messages by parsing the prefix from `recipientId` strings (e.g. `telegram:601870898`). Each adapter owns message splitting via the generic `splitMessage` utility.
```

**Step 3: Update Config section**

Note that `telegramToken` is now `channels: ChannelConfig[]`.

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for channel abstraction"
```

---

### Task 12: Final verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Verify no remaining chatId references in production code**

Run: `grep -rn "chatId" src/ --include="*.ts" | grep -v test | grep -v node_modules`
Expected: No results (only `recipientId` in production code)

Run: `grep -rn "chat_id" src/ --include="*.ts" | grep -v test | grep -v node_modules`
Expected: Only in SQL query strings (the column name stays `chat_id` in the DB — renaming DB columns is a separate concern)
