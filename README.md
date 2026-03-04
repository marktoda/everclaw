# everclaw

AI personal assistant that reasons with [Claude](https://www.anthropic.com/claude), communicates via pluggable messaging channels (Telegram by default), and extends itself at runtime through markdown skill files, tool scripts, and [MCP](https://modelcontextprotocol.io/) servers. Built on [Absurd](https://github.com/marktoda/absurd), a Postgres-native durable task queue.

## How it works

Every inbound message spawns a durable task. The task runs an agent loop — Claude in a tool-use cycle with checkpointing — that can read/write files, query state, execute scripts, call MCP tools, sleep for hours, and resume exactly where it left off after a server restart. There is no in-memory state; everything lives in Postgres.

```
User message (Telegram, etc.)
  → channel adapter spawns "handle-message" task into Postgres
  → Absurd worker picks it up
  → agent loop: load context → call Claude → execute tools → repeat (max 20 turns)
  → text sent back to user via channel adapter
  → all messages persisted to assistant.messages
```

The agent can extend itself by writing files:

- **`skills/*.md`** — Workflow templates with optional cron schedules. Writing a skill file with a `schedule` frontmatter field automatically registers it with Absurd.
- **`scripts/*.sh|.py|.js|.ts`** — Executable scripts, auto-`chmod +x`. Called via `run_script` with JSON on stdin.
- **`servers/*.json`** — MCP server configs. Writing or deleting a config triggers automatic reload — new tools are available on the next message.
- **`data/notes/*.md`** — Persistent notes injected into the system prompt on every turn.

### Durable workflows

The agent has orchestration tools that suspend and resume through Absurd:

| Tool | Behavior |
|---|---|
| `sleep_for` / `sleep_until` | Suspend the task, release the worker slot. Resume after duration or at a specific time. |
| `spawn_task` | Start an independent background task. |
| `wait_for_event` / `emit_event` | Cross-task coordination via named event latches. |
| `cancel_task` / `list_tasks` | Manage running and sleeping tasks. |

Suspending tools throw `SuspendTask`, which propagates to the Absurd worker. The task becomes dormant in Postgres — zero resources consumed — until it's time to wake up. Checkpointing (`ctx.step()`) ensures no Claude API call is repeated on resume.

### Stateless message handling

The agent cannot block waiting for user input. Instead it saves context via `set_state`, lets the task complete, and picks up where it left off when the next message arrives. This keeps worker slots free and scales naturally.

### Channel abstraction

Messaging channels implement the `ChannelAdapter` interface (`start`, `sendMessage`, `stop`). A `ChannelRegistry` routes outbound messages by parsing the prefix from `recipientId` strings (e.g. `telegram:601870898`). Adding a new channel means writing a single adapter file.

### MCP servers

[Model Context Protocol](https://modelcontextprotocol.io/) servers are configured via JSON files in `servers/`, one per server:

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "description": "GitHub API tools"
}
```

On startup (and after any config write/delete), `McpManager` spawns each server as a stdio child process, discovers its tools via `tools/list`, and exposes them as `mcp_<server>_<tool>` in the tool registry. Secrets from `TOOL_*` env vars in `.env` are passed to server processes.

## Architecture

```
src/
  index.ts              Entry point: wires Pool, Anthropic, Absurd, ChannelRegistry; starts worker
  config.ts             Two-tier config: secrets from .env file, rest from process.env
  channels/
    adapter.ts          ChannelAdapter interface & InboundMessage type
    registry.ts         ChannelRegistry: routes messages by recipientId prefix
    telegram.ts         TelegramAdapter: grammY-based Telegram implementation
    split.ts            Generic message splitting utility
  agent/
    loop.ts             Agent loop: checkpointed multi-turn Claude conversation
    tools/              Tool definitions co-located with handlers
      index.ts          createToolRegistry — assembles all tools + executor
      types.ts          ToolRegistry interface, ExecutorDeps type
      files.ts          File tools (read_file, write_file, list_files, delete_file)
      state.ts          State tools (get_state, set_state, get_status)
      scripts.ts        Script tools (run_script)
      search.ts         Search tools (web_search)
      orchestration.ts  Orchestration tools (sleep_for, sleep_until, spawn_task, …)
    prompt.ts           System prompt assembly (injects notes, skills, tool list)
    output.ts           Strips <internal>...</internal> scratchpad tags
  memory/
    history.ts          Conversation history (assistant.messages table)
    messages.ts         History ↔ API format conversion
    state.ts            Key-value state store (assistant.state table)
  skills/
    manager.ts          Skill file parsing and schedule reconciliation
  scripts/
    runner.ts           Script execution via execFile with timeout
  servers/
    manager.ts          McpManager: MCP server lifecycle, tool discovery, routing
  tasks/
    shared.ts           TaskDeps interface + buildAgentDeps helper
    handle-message.ts   Interactive conversation handler
    execute-skill.ts    Scheduled/spawned skill executor
    send-message.ts     Message sender (used by spawn_task)
    workflow.ts         Background work with arbitrary instructions
sql/
  001-absurd.sql        Absurd task queue schema
  002-assistant.sql     App schema: messages + state tables
  003-channel-abstraction.sql  Migration: recipientId prefix support
skills/                 Agent-writable skill files (YAML frontmatter)
scripts/                Agent-writable executable scripts
servers/                MCP server configs (JSON, one per server)
data/notes/             Agent-writable persistent notes
```

## Setup

### Prerequisites

- Node.js 22.18+ (native type stripping — no build step)
- PostgreSQL 15+
- A Telegram bot token ([BotFather](https://t.me/botfather))
- An Anthropic API key

### Install

```bash
pnpm install
```

### Database

Run the SQL migrations against your Postgres instance:

```bash
psql -f sql/001-absurd.sql
psql -f sql/002-assistant.sql
psql -f sql/003-channel-abstraction.sql
```

### Configure

Create a `.env` file with secrets (see `.env.example`):

```
TELEGRAM_BOT_TOKEN=your-bot-token
ANTHROPIC_API_KEY=sk-ant-...
```

Optionally add a Brave Search API key for the `web_search` tool and `TOOL_*` prefixed vars to pass secrets to MCP servers and scripts:

```
BRAVE_SEARCH_API_KEY=BSA...
TOOL_GITHUB_TOKEN=ghp_...
```

Non-secret config uses environment variables with defaults:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://localhost/absurd` | Postgres connection string |
| `QUEUE_NAME` | `assistant` | Absurd queue name (must match `[a-z_][a-z0-9_]*`) |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250929` | Anthropic model ID |
| `MAX_HISTORY_MESSAGES` | `50` | Conversation history window |
| `WORKER_CONCURRENCY` | `2` | Parallel task processing slots |
| `CLAIM_TIMEOUT` | `300` | Task claim timeout in seconds |
| `SCRIPT_TIMEOUT` | `30` | Tool script execution timeout in seconds |
| `NOTES_DIR` | `./data/notes` | Persistent notes directory |
| `SKILLS_DIR` | `./skills` | Skill files directory |
| `TOOLS_DIR` | `./scripts` | Tool scripts directory |
| `SERVERS_DIR` | `./servers` | MCP server configs directory |
| `EXTRA_DIRS` | *(none)* | Additional directories: `name:mode:path,...` (mode: `ro` or `rw`) |

### Run

```bash
node src/index.ts
```

Or with Docker Compose (includes Postgres and [Habitat](https://github.com/marktoda/absurd) task queue UI on port 7890):

```bash
docker compose up --build
```

### Local customization

To add instance-specific config (extra volume mounts, env vars, ports) without modifying tracked files, create a `docker-compose.override.yml` — Docker Compose merges it automatically. This file is gitignored.

For example, to mount a local directory for the agent's `EXTRA_DIRS`:

```yaml
# docker-compose.override.yml
services:
  assistant:
    volumes:
      - /home/me/vaults:/app/extra/vaults:ro
    environment:
      - EXTRA_DIRS=vaults:ro:/app/extra/vaults
```

## Tools

The agent has 16 built-in tools plus any discovered from MCP servers:

| Category | Tools |
|---|---|
| **Files** | `read_file`, `write_file`, `list_files`, `delete_file` |
| **State** | `get_state`, `set_state`, `get_status` |
| **Scripts** | `run_script` |
| **Search** | `web_search` |
| **Orchestration** | `sleep_for`, `sleep_until`, `spawn_task`, `cancel_task`, `list_tasks`, `wait_for_event`, `emit_event` |
| **MCP** | `mcp_<server>_<tool>` — discovered dynamically from `servers/*.json` |

All file operations are sandboxed to `data/notes/`, `skills/`, `scripts/`, `servers/`, and any configured extra directories via path resolution and symlink containment checks.

## Skills

Skills are markdown files with YAML frontmatter:

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

The `schedule` field is a cron expression. When present, Absurd runs the skill automatically via the `execute-skill` task. Skills without a schedule can be triggered manually via `spawn_task`.

Schedule reconciliation happens at startup and whenever a skill file is written or deleted.

## Testing

```bash
pnpm test        # unit + integration (~4s)
npx tsc --noEmit # type-check
pnpm lint        # lint (biome)
```

Three test layers:
- **Unit tests** — mocked, fast, co-located as `*.test.ts`
- **Contract tests** — `FakeAnthropic` validates Anthropic API message contracts
- **Integration tests** — real Postgres via Testcontainers + real Absurd worker

## Development

There is no build step. TypeScript runs directly via Node 22.18+ native type stripping. All import paths use `.ts` extensions. The `tsc --noEmit` script exists only for type-checking.

## License

[MIT](LICENSE)
