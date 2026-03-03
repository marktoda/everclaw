# Channel Abstraction Layer Design

Date: 2026-03-03

## Goal

Decouple Telegram from everclaw's core so messaging channels can be swapped, extended, or run concurrently. Enable future support for WhatsApp, Slack, Discord, etc. with a single-file adapter per platform.

## Approach: Thin Adapter Pattern

Inspired by NanoClaw's `Channel` interface. Each platform implements a minimal `ChannelAdapter` interface. A `ChannelRegistry` routes messages by recipient ID prefix.

### Why This Approach

- YAGNI — text-only is all we need today; rich media can evolve the interface later
- Each adapter is a single file, easy for skills/future users to contribute
- Proven pattern (NanoClaw, similar projects)
- `splitForTelegram` generalizes naturally via `maxMessageLength`

### Rejected Alternatives

- **Message Object Pattern (Bot Framework-style):** Rich `ChannelMessage` type with content variants (text, image, button). Over-engineered for current text-only use case.
- **Event Bus / Middleware Pipeline:** Maximum flexibility but massive over-engineering. Hard to reason about message flow.

## Design

### ChannelAdapter Interface

```typescript
// src/channels/adapter.ts

export interface InboundMessage {
  recipientId: string;   // "telegram:123456789"
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

The adapter owns message splitting internally via a shared `splitMessage(text, maxLen)` utility. Recipient IDs are always prefixed: `telegram:123456789`, `whatsapp:+1234567890`, `slack:C04ABCD`.

The `start()` method is transport-agnostic — works for long polling (Telegram), WebSocket (Slack Socket Mode, Discord), and webhooks (WhatsApp). Transport is an adapter implementation detail.

### TelegramAdapter

```typescript
// src/channels/telegram.ts

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram";
  maxMessageLength = 4096;
  private bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  async start(onMessage) { /* bot.on("message:text", ...) → onMessage */ }
  async sendMessage(recipientId, text) { /* parse chatId, split, bot.api.sendMessage */ }
  async stop() { /* bot.stop() */ }
}
```

grammY remains an implementation detail of this one file. The adapter parses `telegram:123` back to numeric chat ID internally.

### Channel Registry

```typescript
// src/channels/registry.ts

export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void;
  sendMessage(recipientId: string, text: string): Promise<void>;  // routes by prefix
  resolve(recipientId: string): ChannelAdapter;                    // prefix lookup
  startAll(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  stopAll(): Promise<void>;
}
```

Single point of contact for the rest of the app. Routes `sendMessage` by parsing the prefix from `recipientId`.

### Database Migration

```sql
-- sql/003-channel-abstraction.sql
ALTER TABLE assistant.messages ALTER COLUMN chat_id TYPE text USING 'telegram:' || chat_id;
```

Existing rows get prefixed automatically. All queries use parameterized `$1`, no SQL injection concerns.

### Config Changes

```typescript
interface ChannelConfig {
  type: string;       // "telegram"
  token: string;
}

interface Config {
  channels: ChannelConfig[];   // replaces telegramToken
  // ...rest unchanged
}
```

Loaded from the same `TELEGRAM_BOT_TOKEN` secret. Adding a channel means adding another entry.

## Files Changed

| File | Change |
|------|--------|
| **New: `src/channels/adapter.ts`** | `ChannelAdapter` interface, `InboundMessage` type |
| **New: `src/channels/telegram.ts`** | `TelegramAdapter` implementation |
| **New: `src/channels/split.ts`** | Generic `splitMessage(text, maxLen)` |
| **New: `src/channels/registry.ts`** | `ChannelRegistry` |
| **New: `sql/003-channel-abstraction.sql`** | `chat_id` integer → text migration |
| `src/bot.ts` | **Deleted** — replaced by `channels/telegram.ts` |
| `src/index.ts` | Creates registry, registers adapter, passes registry instead of `Bot` |
| `src/config.ts` | `telegramToken` → `channels: ChannelConfig[]` |
| `src/tasks/shared.ts` | Takes registry instead of `Bot`, routes through `registry.sendMessage()` |
| `src/tasks/send-message.ts` | Takes `ChannelRegistry` instead of `Bot` |
| `src/tasks/handle-message.ts` | `chatId: number` → `recipientId: string` |
| `src/tasks/execute-skill.ts` | `chatId: number` → `recipientId: string` |
| `src/tasks/workflow.ts` | `chatId: number` → `recipientId: string` |
| `src/agent/prompt.ts` | Dynamic channel name instead of hardcoded "Telegram" |
| `src/memory/history.ts` | `chatId: number` → `recipientId: string` |
| `src/agent/loop.ts` | `chatId: number` → `recipientId: string` |
| `src/agent/tools/types.ts` | `ExecutorDeps.chatId` → `recipientId: string` |
| `src/agent/tools/orchestration.ts` | `chatId` → `recipientId` in spawn_task |

### What Doesn't Change

- `AgentDeps.onText` — already a `(text: string) => void` callback, already channel-agnostic
- Tool definitions and agent loop structure
- State store, notes, skills system
- Absurd task queue mechanics

## Testing

- Existing tests update `chatId` → `recipientId` with string values
- New unit tests for `splitMessage`, `ChannelRegistry.resolve()`, `TelegramAdapter.sendMessage()` (mocked grammY)
