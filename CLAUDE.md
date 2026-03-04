# CLAUDE.md - everclaw

AI personal assistant built on the Absurd durable task queue. Communicates via pluggable messaging channels (Telegram by default), reasons with Claude (Anthropic), and extends itself through markdown skill files and tool scripts.

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
    adapter.ts          ChannelAdapter interface & InboundMessage type
    registry.ts         ChannelRegistry: routes messages by recipientId prefix
    telegram.ts         TelegramAdapter: grammY-based Telegram implementation
    split.ts            Generic message splitting utility (paragraph → line → hard split)
    index.ts            Barrel export
  agent/
    loop.ts             Agent loop: loads context, calls Claude in a tool-use loop (max 20 turns)
    tools/              Tool definitions co-located with handlers in domain modules
      index.ts          createToolRegistry — assembles all tool definitions + executor
      types.ts          ToolRegistry interface, ToolDeps type
      files.ts          File tools (read_file, write_file, list_files, delete_file)
      state.ts          State tools (get_state, set_state, get_status)
      scripts.ts        Script tools (run_script)
      search.ts         Search tools (web_search)
      orchestration.ts  Orchestration tools (sleep_for, sleep_until, spawn_task, …)
    prompt.ts           System prompt assembly (injects notes, skills, tool list)
    output.ts           Strips <internal>...</internal> scratchpad tags from agent output
  memory/
    history.ts          Conversation history (Postgres assistant.messages table)
    messages.ts         History ↔ API format: reconstructMessages, deconstructMessages, sanitizeMessages
    state.ts            Key-value state store (Postgres assistant.state table, namespaced)
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
    send-message.ts     Task: sends a message via ChannelRegistry (used by spawn_task)
    workflow.ts         Task: runs agent loop with arbitrary instructions (background work)
sql/
  001-absurd.sql        Absurd task queue schema (absurd schema)
  002-assistant.sql     App schema: assistant.messages + assistant.state tables
  003-channel-abstraction.sql  Migration: chat_id integer→text with 'telegram:' prefix
skills/                 Agent-writable skill .md files (YAML frontmatter with optional schedule)
scripts/                Agent-writable executable scripts (.sh, .py, .js, .ts)
servers/                MCP server configs (JSON, one file per server)
data/notes/             Agent-writable persistent notes
docs/plans/             Design and implementation documents
```

## Key Patterns

**Channel abstraction.** Messaging channels implement the `ChannelAdapter` interface (`start`, `sendMessage`, `stop`). A `ChannelRegistry` routes outbound messages by parsing the prefix from `recipientId` strings (e.g. `telegram:123456789`). Each adapter owns message splitting via the generic `splitMessage` utility. Adding a new channel means writing a single adapter file.

**Stateless message handling.** Every inbound message spawns a fresh `handle-message` task. There is no "wait for reply" — the agent saves state via `set_state`, completes, and picks up context on the next message from conversation history.

**Durable workflows.** The agent has orchestration tools (`sleep_for`, `sleep_until`, `wait_for_event`, `emit_event`, `spawn_task`, `cancel_task`, `list_tasks`) that suspend and resume durably through Absurd. Suspending tools must NOT be wrapped in `ctx.step()` — they throw `SuspendTask` which must propagate to the Absurd worker.

**Path containment.** `resolvePath` in `agent/tools/files.ts` validates that all file tool paths resolve within one of four writable directories (`data/notes/`, `skills/`, `scripts/`, `servers/`). Paths that escape are rejected.

**Config: secrets vs env.** Secrets (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`) are read from `.env` file only and never set in `process.env`. Non-secret config (`DATABASE_URL`, `QUEUE_NAME`, `CLAUDE_MODEL`, etc.) comes from `process.env` with defaults. Channel tokens are stored in `config.channels[]`. Queue name is validated as a safe SQL identifier at load time.

**Skill schedule sync.** Writing or deleting a skill file in `skills/` triggers `syncSchedules`, which reconciles YAML frontmatter `schedule` fields with Absurd's schedule registry. Schedules are prefixed `skill:`.

**Tool scripts.** Files written to `scripts/` are auto-`chmod +x`. Scripts receive JSON on stdin and return output on stdout, with a configurable timeout (default 30s).

**MCP server integration.** MCP (Model Context Protocol) servers are configured via JSON files in `servers/`, one per server. On startup, `McpManager` spawns each server as a stdio child process, discovers its tools via `tools/list`, and exposes them through the ToolRegistry with `mcp_<server>_<tool>` namespacing. Secrets from `TOOL_*` env vars are passed to server processes. Changes to `servers/` trigger automatic MCP reload (new tools are available on the next message).

**Agent scratchpad.** The agent can use `<internal>...</internal>` tags for reasoning that gets stripped before sending to the user (see `output.ts`).

## Tools (16 built-in + dynamic MCP tools)

| Category | Tools |
|---|---|
| Files (4) | `read_file`, `write_file`, `list_files`, `delete_file` |
| State (3) | `get_state`, `set_state`, `get_status` |
| Scripts (1) | `run_script` |
| Search (1) | `web_search` |
| Orchestration (7) | `sleep_for`, `sleep_until`, `spawn_task`, `cancel_task`, `list_tasks`, `wait_for_event`, `emit_event` |
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
