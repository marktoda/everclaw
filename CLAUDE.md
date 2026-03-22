# CLAUDE.md - everclaw

AI personal assistant built on the Absurd durable task queue. Communicates via pluggable messaging channels (Telegram, Discord, Slack, WhatsApp, Gmail), reasons with Claude (Anthropic), and extends itself through markdown skill files and tool scripts.

## Commands

```bash
pnpm install                              # install dependencies
pnpm test                                 # run tests (vitest --run)
npx tsc --noEmit                          # type-check (no build step)
node src/index.ts                             # run the app
docker compose up --build                 # run with Postgres via Docker
```

There is no build step. TypeScript runs directly via `node` (Node 22.18+ strips types natively). The `pnpm build` script (`tsc --noEmit`) exists but is only used for type-checking CI; the app never uses `dist/`.

## Architecture

```
src/
  index.ts              Entry point: creates Pool, Anthropic, Absurd, ChannelRegistry; registers tasks; starts worker
  config.ts             Config: secrets from .env file, non-secrets from process.env
  channels/
    adapter.ts          ChannelAdapter interface (start, sendMessage, stop, setTyping?) & InboundMessage type
    registry.ts         ChannelRegistry: routes messages by chatId prefix, setTyping passthrough
    telegram.ts         TelegramAdapter: grammY-based Telegram implementation
    discord.ts          DiscordAdapter: discord.js, 2000 char limit, typing indicators
    slack.ts            SlackAdapter: @slack/bolt Socket Mode, pipe-delimited tokens, 4000 char limit
    whatsapp.ts         WhatsAppAdapter: Baileys, QR auth, reconnection with backoff, typing
    gmail.ts            GmailAdapter: googleapis OAuth2, email polling, threaded replies
    adapters.ts         Adapter factory: maps channel type → adapter constructor
    auth.ts             Shared authDir() helper — resolves data/auth/{adapter}/
    split.ts            Generic message splitting utility (paragraph → line → hard split)
    format-telegram.ts  Markdown → Telegram MessageEntity conversion
    index.ts            Barrel export
  transcription.ts      Shared audio transcription via OpenAI Whisper
  child-env.ts          Minimal environment forwarded to child processes (PATH, HOME only)
  logger.ts             Pino logger instance, LOG_LEVEL from process.env
  agent/
    loop.ts             Agent loop: loads context, calls Claude in a tool-use loop (max 50 turns)
    tools/              Tool definitions co-located with handlers in domain modules
      index.ts          Barrel export for ToolRegistry and types
      registry.ts       createToolRegistry — assembles all tool definitions + executor
      types.ts          ToolHandler interface, ExecutorDeps type, defineTool helper
      files.ts          File tools (read_file, write_file, glob_files, grep_files, delete_file)
      status.ts         Status tool (get_status)
      scripts.ts        Script tools (run_script)
      search.ts         Search tools (web_search, search_servers)
      orchestration.ts  Orchestration tools (sleep_for, sleep_until, spawn_workflow, spawn_skill, send_message, …)
      channels.ts       Channel tools (read_messages — query messages from channels like Gmail)
      browser.ts        Browser tool (browser — automation via agent-browser CLI)
    prompt.ts           System prompt assembly (injects notes, skills, tool list)
    output.ts           Strips <internal>...</internal> scratchpad tags from agent output
  memory/
    history.ts          Conversation history (Postgres assistant.messages table)
    messages.ts         History ↔ API format: reconstructMessages, deconstructMessages, sanitizeMessages
  skills/
    manager.ts          Skill file parser (YAML frontmatter) and schedule sync with Absurd
  scripts/
    runner.ts           External script runner (execFile with timeout, stdin JSON)
  servers/
    manager.ts          McpManager: MCP server lifecycle, tool discovery, and routing
  tasks/
    shared.ts           TaskDeps interface + buildAgentDeps helper (shared by all agent tasks)
    handle-message.ts   Task: wires agent loop for a user message
    execute-skill.ts    Task: reads a skill .md file and runs it through the agent loop
    send-message.ts     Task: sends a message via ChannelRegistry (used by send_message tool)
    workflow.ts         Task: runs agent loop with arbitrary instructions (background work)
sql/
  001-absurd.sql        Absurd task queue schema (absurd schema)
  002-assistant.sql     App schema: assistant.messages table
  003-channel-abstraction.sql  Migration: chat_id integer→text with 'telegram:' prefix
  004-drop-state-table.sql     Drops deprecated assistant.state table
skills/                 Agent-writable skill .md files (YAML frontmatter with optional schedule)
scripts/                Agent-writable executable scripts (.sh, .py, .js, .ts)
servers/                MCP server configs (JSON, one file per server)
data/notes/             Agent-writable persistent notes
  pinned/               Critical notes loaded every message (profile, preferences)
  temp/                 Scratch space (not listed in prompt, not auto-loaded)
docs/plans/             Design and implementation documents
```

## Key Patterns

**Channel abstraction.** Messaging channels implement the `ChannelAdapter` interface (`start`, `sendMessage`, `stop`, optional `setTyping`). Five adapters: Telegram, Discord, Slack, WhatsApp, Gmail. A `ChannelRegistry` routes outbound messages by parsing the prefix from `chatId` strings (e.g. `telegram:123456789`, `discord:123`, `whatsapp:15551234567`). Each adapter owns message splitting via the generic `splitMessage` utility. Adding a new channel means writing a single adapter file and one factory entry.

**Pluggable channels.** Channels are auto-detected from `CHANNEL_*` secrets in `.env` (e.g. `CHANNEL_TELEGRAM` → telegram adapter, `CHANNEL_DISCORD` → discord). The adapter factory in `channels/adapters.ts` maps type strings to constructors. WhatsApp and Gmail use truthy flags (`CHANNEL_WHATSAPP=1`, `CHANNEL_GMAIL=1`) since they authenticate interactively. Slack uses a pipe-delimited `bot_token|app_token` value.

**Channel auth state.** Adapters requiring persistent auth (WhatsApp, Gmail) store state under `data/auth/{adapter}/` via the shared `authDir()` helper in `channels/auth.ts`. WhatsApp stores Baileys session files; Gmail stores OAuth2 credentials, token cache, and polling state. The `data/` directory is fully gitignored.

**Typing indicators.** `ChannelAdapter.setTyping?(chatId, isTyping)` is optional. `handle-message.ts` calls `setTyping(chatId, true)` before the agent loop (fire-and-forget with `.catch(() => {})`). Discord and WhatsApp implement it; Slack's is a no-op; Gmail omits it entirely.

**Voice transcription.** When `OPENAI_API_KEY` is set, adapters can transcribe voice messages via OpenAI Whisper (shared `transcription.ts` module) and deliver them as `[Voice: transcript]`. Currently used by Telegram and WhatsApp adapters. Without the key, voice messages are silently ignored.

**Multi-channel semantics.** Everclaw is a single-agent, multi-channel system. When multiple channels are configured, they share everything except conversation history: same agent prompt, same notes/skills/scripts, same Absurd queue and worker pool, same Postgres database. Conversation history is isolated per `chatId` — `telegram:123` and `discord:456` are separate threads even if they're the same person. The agent has no awareness of which channel it's on; it only sees the `chatId` string. The `send_message` tool can send cross-channel (e.g., receive on Telegram, send to Discord) as long as the target is in `ALLOWED_CHAT_IDS`. Channels start sequentially — if one adapter fails to start, the rest don't start either.

**Stateless message handling.** Every inbound message spawns a fresh `handle-message` task. There is no "wait for reply" — the agent saves context to files, completes, and picks up context on the next message from conversation history.

**Durable workflows.** The agent has orchestration tools (`sleep_for`, `sleep_until`, `wait_for_event`, `emit_event`, `spawn_workflow`, `spawn_skill`, `send_message`, `cancel_task`, `list_tasks`) that suspend and resume durably through Absurd. Suspending tools must NOT be wrapped in `ctx.step()` — they throw `SuspendTask` which must propagate to the Absurd worker.

**Path containment.** `resolvePath` in `agent/tools/files.ts` validates that all file tool paths resolve within allowed directories: four built-in (`data/notes/`, `skills/`, `scripts/`, `servers/`) plus any user-configured extra directories. Paths that escape are rejected.

**Extra directories.** Users can mount additional directories via the `EXTRA_DIRS` env var (`name:mode:path` comma-separated, e.g. `vaults:ro:/mnt/vaults`). Each gets read-only or read-write access through the same file tools, with the same path containment and symlink protection as built-in dirs. No side-effects (no schedule sync, chmod, etc.).

**Config: secrets vs env.** Secrets (`CHANNEL_TELEGRAM`, `CHANNEL_DISCORD`, `CHANNEL_SLACK`, `CHANNEL_WHATSAPP`, `CHANNEL_GMAIL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are read from `.env` file only and never set in `process.env`. Non-secret config (`DATABASE_URL`, `QUEUE_NAME`, `CLAUDE_MODEL`, etc.) comes from `process.env` with defaults. Three prefix conventions route secrets to subsystems: `CHANNEL_*` (channel tokens, prefix stripped to get type), `SCRIPT_*` (passed to tool scripts, prefix stripped), `SERVER_*` (passed to MCP servers, prefix stripped). `SCRIPT_*` and `SERVER_*` use the shared `parsePrefixedEnv` helper; channels use a similar prefix-based parser that returns `ChannelConfig[]`. The Config type groups related fields: `config.agent` (model, history), `config.worker` (database, queue, concurrency), `config.dirs` (notes, skills, scripts, servers, extra). Queue name is validated as a safe SQL identifier at load time.

**Chat ID allowlist.** `ALLOWED_CHAT_IDS` in `.env` (comma-separated, fully prefixed IDs like `telegram:123456789`) restricts which users can interact with the agent. When unset/empty the bot runs in **discovery mode** — it replies with the sender's chat ID and setup instructions instead of running the agent. When set, unauthorized messages are silently ignored (logged at warn). Filtering happens in `index.ts` before any task is spawned.

**Skill schedule sync.** Writing or deleting a skill file in `skills/` triggers `syncSchedules`, which reconciles YAML frontmatter `schedule` fields with Absurd's schedule registry. Schedules are prefixed `skill:`.

**Tool scripts.** Files written to `scripts/` are auto-`chmod +x`. Scripts receive JSON on stdin and return output on stdout, with a configurable timeout (default 30s).

**MCP server integration.** MCP (Model Context Protocol) servers are configured via JSON files in `servers/`, one per server. On startup, `McpManager` spawns each server as a stdio child process, discovers its tools via `tools/list`, and exposes them through the ToolRegistry with `mcp_<server>_<tool>` namespacing. Secrets for MCP servers use the `SERVER_` prefix in `.env` — the prefix is stripped before passing to server processes (e.g. `SERVER_GITHUB_PERSONAL_ACCESS_TOKEN` → `GITHUB_PERSONAL_ACCESS_TOKEN`). This is separate from `SCRIPT_*` vars which go to tool scripts. Changes to `servers/` trigger automatic MCP reload (new tools are available on the next message). The agent can discover new MCP servers via `search_servers`, which queries the official MCP registry at `registry.modelcontextprotocol.io`. The agent must ask the user for approval before writing any server config.

**Notes tiers.** Notes are split into three tiers under `data/notes/`: `pinned/` (full content loaded into every system prompt, size-capped at 8KB), root-level `.md` files (listed by filename in the prompt, loaded on demand via `read_file`), and `temp/` (invisible scratch space, not listed or loaded). The agent moves notes between tiers using `write_file` and `delete_file`.

**Directory hooks.** Side effects triggered by `write_file` and `delete_file` are declared in a `DIR_HOOKS` map in `agent/tools/files.ts`. Each directory can specify `validate` (pre-write), `onWrite`, and `onDelete` hooks. Currently: `skills` syncs schedules, `scripts` auto-chmod, `servers` validates JSON + reloads MCP. Adding new directory behaviors is declarative.

**Agent scratchpad.** The agent can use `<internal>...</internal>` tags for reasoning that gets stripped before sending to the user (see `output.ts`).

## Tools (20 built-in + dynamic MCP tools)

| Category | Tools |
|---|---|
| Files (5) | `read_file`, `write_file`, `glob_files`, `grep_files`, `delete_file` |
| Status (1) | `get_status` |
| Scripts (1) | `run_script` |
| Search (2) | `web_search`, `search_servers` |
| Orchestration (9) | `sleep_for`, `sleep_until`, `spawn_workflow`, `spawn_skill`, `send_message`, `cancel_task`, `list_tasks`, `wait_for_event`, `emit_event` |
| Channels (1) | `read_messages` |
| Browser (1) | `browser` |
| MCP (dynamic) | `mcp_<server>_<tool>` — discovered at startup from `servers/*.json` configs |

## Testing

Tests use vitest. Run everything with `pnpm test` (unit + integration, ~4s). Integration tests use Testcontainers to spin up real Postgres.

Three layers: unit tests (mocked, fast), contract tests (FakeAnthropic validates Anthropic API message contracts), integration tests (real Postgres + real Absurd worker). Test infrastructure lives in `src/test/` — `fake-anthropic.ts`, `scenarios.ts`, `harness.ts`. History ↔ API message conversion is tested in `src/memory/messages.test.ts`.

## Gotchas

- **No build step**: Do not look for or try to create a `dist/` directory. The app runs TypeScript directly.
- **`.ts` imports in TypeScript**: All import paths use `.ts` extensions (e.g., `import { loadConfig } from "./config.ts"`). This works natively with Node 22.18+ type stripping — no `--experimental-strip-types` flag needed.
- **Suspending tools vs `ctx.step()`**: `sleep_for`, `sleep_until`, and `wait_for_event` throw `SuspendTask` and must NOT be wrapped in `ctx.step()`. Other tool calls should be wrapped in `ctx.step()` for checkpointing.
- **SQL injection surface**: `list_tasks` in `agent/tools/orchestration.ts` interpolates `queueName` directly into SQL. This is safe because `loadConfig` validates it as `/^[a-z_][a-z0-9_]*$/i` — do not bypass this validation.
- **Secret isolation**: Secrets are read from `.env` file, not `process.env`. Do not use `dotenv` or similar libraries that set `process.env`.
- **MCP reload timing**: Writing/deleting in `servers/` triggers `McpManager.reload()`, but the current task's tool registry is already frozen. New MCP tools are available starting with the next message/task.
- **Server config validation**: `write_file` to `servers/` validates JSON structure and enforces a command allowlist (`node`, `npx`, `uvx`, `python3`, `python`, `docker` — hardcoded in `src/servers/manager.ts`). Only `.json` files at the top level are accepted.
- **`ALLOWED_CHAT_IDS` format**: Uses fully prefixed IDs (e.g. `telegram:123456789`, not bare `123456789`). Discovery mode shows the correct format.
- **`SCRIPT_*` prefix stripping**: Script env vars use the `SCRIPT_` prefix in `.env`, but the prefix is stripped before passing to scripts. Scripts see `MY_KEY`, not `SCRIPT_MY_KEY`.
- **`CHANNEL_*` convention**: Channel tokens use `CHANNEL_<TYPE>` in `.env` (e.g. `CHANNEL_TELEGRAM`). The type is extracted from the key name after the prefix.
- **Slack dual tokens**: `CHANNEL_SLACK` is pipe-delimited `bot_token|app_token`. Both are required for Socket Mode.
- **WhatsApp QR auth**: WhatsApp uses QR code authentication on first run (printed to terminal). Session files persist in `data/auth/whatsapp/`. The adapter reconnects with exponential backoff (1s→60s cap) and cleans up event listeners before each reconnect.
- **Gmail OAuth2 + initial sync**: Gmail requires OAuth2 interactive auth on first run. On startup, existing unread emails are marked as seen without processing to avoid a flood of old messages. Per-sender thread context is tracked for proper `In-Reply-To`/`References` headers.
- **WhatsApp message containers**: WhatsApp messages are wrapped in various container types (conversation, extendedTextMessage, ephemeral, viewOnce, editedMessage). The adapter unwraps all of these to extract text.
- **Discord Gateway Intents**: The Discord adapter requires MessageContent, GuildMessages, and DirectMessages gateway intents to be enabled in the Discord Developer Portal.
- **Channel startup is sequential**: Adapters start one at a time via `ChannelRegistry.startAll()`. If one fails (e.g., invalid Discord token), subsequent adapters don't start. Telegram's bot polling crash calls `process.exit(1)`, killing all channels.
- **Cross-channel send_message**: The agent's `send_message` tool can target any `recipientId` in `ALLOWED_CHAT_IDS`, regardless of which channel the current conversation is on. This enables cross-channel workflows (e.g., receive on Telegram, alert on Discord).
- **`docker-compose.override.yml`**: Personal/local Docker config goes in `docker-compose.override.yml` (gitignored), not `docker-compose.yml` (open source default). Docker Compose silently merges the override on top — environment variables with the same key are **replaced**, not merged. When debugging container config issues (e.g. `EXTRA_DIRS`), always check the override file first.
