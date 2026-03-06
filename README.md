<p align="center">
  <img src="assets/logo.png" alt="Everclaw" width="200" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/marktoda/everclaw?style=flat&color=yellow" alt="GitHub Stars" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/TypeScript-blue?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Powered%20by-Claude-cc785c?logo=anthropic&logoColor=white" alt="Powered by Claude" />
</p>

# everclaw

A durable personal AI assistant.

## Highlights

- **Durable execution** — every Claude API call and tool execution is checkpointed in Postgres. Replayed on resume, never repeated.
- **Sleeps, schedules, coordination** — `sleep_for`, `sleep_until`, cron-scheduled skills, and cross-task event latches, all backed by [Absurd](https://github.com/earendil-works/absurd).
- **Self-extending** — the agent writes its own skill files, tool scripts, and [MCP](https://modelcontextprotocol.io/) server configs at runtime.
- **Pluggable channels** — Telegram, Discord, Slack, WhatsApp, Gmail. One adapter file per channel.
- **20 built-in tools** — files, scripts, web search, orchestration, browser automation, plus any tools discovered from MCP servers.
- **Just Postgres** — the only infrastructure dependency. History, task queue, checkpoints, schedules. All in one place.

## Quick start

```bash
git clone https://github.com/marktoda/everclaw.git
cd everclaw
claude
```

Then run `/setup`. It handles dependencies, database, config, and verification.

Or with Docker Compose (bundles Postgres and [Habitat](https://github.com/earendil-works/absurd) task queue UI on port 7890):

```bash
cp .env.example .env
# fill in your API keys
docker compose up --build
```

## How it works

Every inbound message spawns a durable task. The task runs an agent loop (Claude in a tool-use cycle with checkpointing) that can read/write files, run scripts, search the web, call MCP tools, sleep for hours, and resume where it left off.

```
User message (Telegram, etc.)
  → channel adapter spawns "handle-message" task into Postgres
  → Absurd worker picks it up
  → agent loop: load context → call Claude → execute tools → repeat (max 50 turns)
  → text sent back via channel adapter
  → messages persisted to assistant.messages
```

The agent extends itself by writing files:

- **`skills/*.md`** — workflow templates with optional cron schedules. Drop a `schedule` field in the YAML frontmatter and Absurd picks it up automatically.
- **`scripts/*.sh|.py|.js|.ts`** — executable tool scripts, auto-`chmod +x`. Called via `run_script` with JSON on stdin. Python runs through [`uv`](https://docs.astral.sh/uv/).
- **`servers/*.json`** — MCP server configs. Write or delete one, and the server reloads. New tools show up on the next message.
- **`data/notes/*.md`** — persistent notes injected into the system prompt every turn.

### Why durability matters

The agent loop is checkpoint-aware: every `ctx.step()` records its result in Postgres. When a task resumes (after a sleep, a restart, a crash), Absurd replays cached steps and continues from the last one. API calls don't re-fire. Side effects don't duplicate.

That's what makes the orchestration tools work:

| Tool | What it does |
|---|---|
| `sleep_for` / `sleep_until` | Suspend the task, free the worker slot. Wake up after a duration or at a specific time. |
| `spawn_workflow` / `spawn_skill` | Kick off independent background tasks (freeform instructions or a skill file). |
| `send_message` | Fire off a message without spinning up the agent loop. |
| `wait_for_event` / `emit_event` | Cross-task coordination through named event latches. |
| `cancel_task` / `list_tasks` | Manage running and sleeping tasks. |

Suspending tools throw `SuspendTask`, which propagates up to the Absurd worker. The task goes dormant in Postgres until it's time to wake. Zero resources while sleeping.

### Stateless message handling

The agent can't block waiting for user input. It saves context to files, lets the task finish, and picks up where it left off when the next message comes in. Worker slots stay free, scales naturally.

### Channels

Five adapters implement the `ChannelAdapter` interface (`start`, `sendMessage`, `stop`): Telegram (grammY), Discord (discord.js), Slack (Bolt Socket Mode), WhatsApp (Baileys), and Gmail (googleapis). A `ChannelRegistry` routes outbound messages by parsing the prefix from `chatId` strings (e.g. `telegram:123456789`, `discord:456`). Channels are auto-detected from `CHANNEL_*` secrets in `.env`. Bolting on a new channel means one adapter file and one line in the factory map.

Voice messages work too: if `OPENAI_API_KEY` is set, the Telegram and WhatsApp adapters transcribe voice via Whisper and deliver `[Voice: transcript]`.

### MCP servers

[MCP](https://modelcontextprotocol.io/) servers live as JSON files in `servers/`:

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "description": "GitHub API tools"
}
```

`McpManager` spawns each one as a stdio child process, discovers tools via `tools/list`, and exposes them as `mcp_<server>_<tool>`. Secrets use the `SERVER_*` prefix in `.env` (prefix gets stripped before passing to the process, so `SERVER_GITHUB_PERSONAL_ACCESS_TOKEN` becomes `GITHUB_PERSONAL_ACCESS_TOKEN`). Commands are restricted to an allowlist: `node`, `npx`, `uvx`, `python3`, `python`, `docker`.

The agent can also find new servers via `search_servers`, which queries the official MCP registry.

## Architecture

TypeScript, runs directly on Node 22.18+ with native type stripping. There's no build step.

### Core

| Module | What it does |
|---|---|
| `src/index.ts` | Wires up Pool, Anthropic, Absurd, ChannelRegistry, McpManager. Registers tasks, starts the worker. |
| `src/config.ts` | Two-tier config: secrets from `.env` (never touches `process.env`), everything else from environment vars. |

### Agent

| Module | What it does |
|---|---|
| `agent/loop.ts` | The main loop. Checkpointed multi-turn Claude conversation, max 50 turns. |
| `agent/prompt.ts` | Builds the system prompt: notes, skills, scripts, MCP servers, extra dirs. |
| `agent/output.ts` | Strips `<internal>...</internal>` scratchpad tags before the user sees anything. |
| `agent/tools/` | 20 built-in tools across 7 files. Registry in `registry.ts`. |

### Tools

| File | Tools |
|---|---|
| `tools/files.ts` | `read_file`, `write_file`, `glob_files`, `grep_files`, `delete_file` (sandboxed, symlink-checked) |
| `tools/status.ts` | `get_status` (uptime, file counts) |
| `tools/scripts.ts` | `run_script` (JSON stdin, configurable timeout) |
| `tools/search.ts` | `web_search` (Brave), `search_servers` (MCP registry) |
| `tools/orchestration.ts` | `sleep_for`, `sleep_until`, `spawn_workflow`, `spawn_skill`, `send_message`, `cancel_task`, `list_tasks`, `wait_for_event`, `emit_event` |
| `tools/channels.ts` | `read_messages` (query messages from channels like Gmail) |
| `tools/browser.ts` | `browser` (automation via agent-browser CLI) |

### Channels

| File | What it does |
|---|---|
| `channels/adapter.ts` | `ChannelAdapter` interface, `InboundMessage` type |
| `channels/registry.ts` | Routes messages by `chatId` prefix |
| `channels/telegram.ts` | grammY-based Telegram adapter (text + voice) |
| `channels/discord.ts` | discord.js adapter (2000 char limit, typing indicators) |
| `channels/slack.ts` | Bolt Socket Mode adapter (pipe-delimited dual tokens, 4000 char limit) |
| `channels/whatsapp.ts` | Baileys adapter (QR auth, reconnection with backoff, voice) |
| `channels/gmail.ts` | googleapis OAuth2 adapter (email polling, threaded replies) |
| `channels/adapters.ts` | Factory: channel type string → adapter constructor |
| `channels/auth.ts` | Shared `authDir()` helper for persistent auth state |
| `channels/split.ts` | Message splitting (paragraph → line → hard cut) |
| `channels/format-telegram.ts` | Markdown → Telegram HTML |
| `transcription.ts` | Whisper transcription (shared across voice-capable adapters) |

### Persistence

| File | What it does |
|---|---|
| `memory/history.ts` | Conversation history (`assistant.messages` table) |
| `memory/messages.ts` | DB ↔ Anthropic API format conversion; cleans up orphaned tool results |

### Tasks

4 durable task types registered with Absurd:

| File | Task | What it does |
|---|---|---|
| `tasks/handle-message.ts` | `handle-message` | User messages → agent loop |
| `tasks/execute-skill.ts` | `execute-skill` | Runs a skill `.md` through the agent loop (manual or cron) |
| `tasks/send-message.ts` | `send-message` | Sends a message through the channel adapter (no agent loop) |
| `tasks/workflow.ts` | `workflow` | Background agent with freeform instructions |

### Extensions

| File | What it does |
|---|---|
| `skills/manager.ts` | Parses skill frontmatter, reconciles cron schedules with Absurd |
| `scripts/runner.ts` | Runs scripts via `execFile` with timeout; Python through `uv run` |
| `servers/manager.ts` | MCP server lifecycle: spawn, discover tools, route calls, reload on config changes |

### Data directories

| Path | What's in it |
|---|---|
| `sql/` | Postgres migrations (Absurd schema, app tables, channel abstraction) |
| `skills/` | Agent-writable skill files (YAML frontmatter, optional cron) |
| `scripts/` | Agent-writable executable scripts |
| `servers/` | MCP server configs (JSON, one per server) |
| `data/notes/` | Agent-writable persistent notes |

## Configuration

Secrets go in `.env` (read from the file directly, never set in `process.env`) with prefix conventions:

| Prefix | Where it goes | Example |
|---|---|---|
| `CHANNEL_*` | Channel tokens (type from key name) | `CHANNEL_TELEGRAM=bot-token` |
| `SCRIPT_*` | Tool scripts (prefix stripped) | `SCRIPT_MY_KEY=secret` → scripts see `MY_KEY` |
| `SERVER_*` | MCP servers (prefix stripped) | `SERVER_GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...` |

Optional:

```
BRAVE_SEARCH_API_KEY=BSA...     # web_search tool
OPENAI_API_KEY=sk-...           # voice transcription
ALLOWED_CHAT_IDS=telegram:123   # comma-separated, fully prefixed
```

If `ALLOWED_CHAT_IDS` isn't set, the bot runs in **discovery mode**: it replies with the sender's chat ID so you know what to put in the allowlist. Once set, unauthorized messages get dropped silently.

Environment variables (non-secret, with defaults):

| Variable | Default | What it controls |
|---|---|---|
| `DATABASE_URL` | `postgresql://localhost/absurd` | Postgres connection |
| `QUEUE_NAME` | `assistant` | Absurd queue name (must match `[a-z_][a-z0-9_]*`) |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250929` | Model ID |
| `MAX_HISTORY_MESSAGES` | `50` | Conversation history window |
| `WORKER_CONCURRENCY` | `2` | Parallel task slots |
| `CLAIM_TIMEOUT` | `300` | Task claim timeout (seconds) |
| `SCRIPT_TIMEOUT` | `30` | Script execution timeout (seconds) |
| `EXTRA_DIRS` | *(none)* | Extra directories: `name:mode:path,...` (`ro` or `rw`) |
| `LOG_LEVEL` | `info` | Pino log level |

### Local customization

For instance-specific config (extra volumes, env vars, ports) without touching tracked files, create a `docker-compose.override.yml`. Docker Compose merges it automatically. It's gitignored.

```yaml
# docker-compose.override.yml
services:
  assistant:
    volumes:
      - /home/me/vaults:/app/extra/vaults:ro
    environment:
      - EXTRA_DIRS=vaults:ro:/app/extra/vaults
```

## Skills

Markdown files with YAML frontmatter:

```markdown
---
name: morning-briefing
description: Check the weather and summarize calendar
schedule: "0 9 * * *"
---

## Instructions

Check the weather for San Francisco and summarize today's calendar events.
Send a brief morning update to the user.
```

The `schedule` field is a cron expression. Absurd runs scheduled skills automatically via the `execute-skill` task. Skills without a schedule can be fired manually via `spawn_skill`.

Schedule reconciliation runs at startup and whenever a skill file changes.

## Testing

```bash
pnpm test        # unit + integration (~4s)
npx tsc --noEmit # type-check
pnpm lint        # biome
```

3 test layers:
- **Unit** — mocked, fast, co-located as `*.test.ts`
- **Contract** — `FakeAnthropic` validates Anthropic API message structure (role alternation, tool_use/tool_result pairing)
- **Integration** — real Postgres via Testcontainers + real Absurd worker

## Inspirations

- **[OpenClaw](https://github.com/openclaw/openclaw)** — the original AI personal assistant project. Everclaw borrows the vision of a self-extending agent but leans on durable workflows and Postgres instead of in-memory state and Redis.
- **[NanoClaw](https://github.com/qwibitai/nanoclaw)** — stripped-back personal assistant with container isolation. Everclaw trades container sandboxing for durable execution: the agent can sleep, schedule, and coordinate across tasks in ways ephemeral processes can't.
- **[Absurd](https://github.com/earendil-works/absurd)** — the Postgres-native durable execution engine underneath all of this. Everclaw is really just a thin agent layer bolted on top of Absurd's task queue, checkpointing, scheduling, and event system.

## License

[MIT](LICENSE)
