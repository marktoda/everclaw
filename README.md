# everclaw

AI personal assistant that communicates via Telegram, reasons with Claude, and extends itself at runtime through markdown skill files and tool scripts. Built on [Absurd](https://github.com/marktoda/absurd), a Postgres-native durable task queue.

## How it works

Every Telegram message spawns a durable task. The task runs an agent loop — Claude in a tool-use cycle with checkpointing — that can read/write files, query state, execute scripts, sleep for hours, and resume exactly where it left off after a server restart. There is no in-memory state; everything lives in Postgres.

```
Telegram message
  → bot spawns "handle-message" task into Postgres
  → Absurd worker picks it up
  → agent loop: load context → call Claude → execute tools → repeat (up to 20 turns)
  → text streamed back to user via Telegram as each turn completes
  → all messages persisted to assistant.messages
```

The agent can extend itself by writing files:

- **`skills/*.md`** — Workflow templates with optional cron schedules. Writing a skill file with a `schedule` frontmatter field automatically registers it with Absurd.
- **`scripts/*.sh|.py|.js|.ts`** — Executable scripts, auto-`chmod +x`. The agent calls them via `run_script` with JSON on stdin.
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

### No "wait for reply"

The agent cannot block waiting for user input. Instead it saves context via `set_state`, lets the task complete, and picks up where it left off when the next message arrives. This keeps worker slots free and scales naturally.

## Architecture

```
src/
  index.ts              Entry point — wires dependencies, boots worker + bot
  config.ts             Two-tier config: secrets from .env file, rest from process.env
  bot.ts                Telegram bot (grammY) — spawns handle-message per incoming text
  agent/
    loop.ts             Agent loop — checkpointed multi-turn Claude conversation
    tools.ts            15 tool definitions (Anthropic API schema format)
    executor.ts         Tool dispatcher with path containment and side effects
    prompt.ts           System prompt assembly — injects notes, skills, tool list
    output.ts           Strips <internal>...</internal> scratchpad tags
  memory/
    history.ts          Conversation history (assistant.messages table)
    state.ts            Key-value state store (assistant.state table)
  skills/
    manager.ts          Skill file parsing and schedule reconciliation
  scripts/
    runner.ts           Script execution via execFile with timeout
  tasks/
    handle-message.ts   Interactive conversation handler (full history)
    execute-skill.ts    Scheduled/spawned skill executor (limited history)
    send-message.ts     Simple Telegram message sender
    workflow.ts         Background work with arbitrary instructions
sql/
  001-absurd.sql        Absurd task queue schema
  002-assistant.sql     App schema: messages + state tables
skills/                 Agent-writable skill files
scripts/                Agent-writable scripts
data/notes/             Agent-writable persistent notes
```

## Setup

### Prerequisites

- Node.js 22.18+ (native type stripping)
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
```

### Configure

Create a `.env` file with secrets:

```
TELEGRAM_BOT_TOKEN=your-bot-token
ANTHROPIC_API_KEY=sk-ant-...
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

### Run

```bash
node src/index.ts
```

Or with Docker Compose (includes Postgres):

```bash
docker compose up --build
```

## Tools

The agent has 15 tools across 4 categories:

| Category | Tools |
|---|---|
| **Files** | `read_file`, `write_file`, `list_files`, `delete_file` |
| **State** | `get_state`, `set_state`, `get_status` |
| **Scripts** | `run_script` |
| **Orchestration** | `sleep_for`, `sleep_until`, `spawn_task`, `cancel_task`, `list_tasks`, `wait_for_event`, `emit_event` |

All file operations are sandboxed to `data/notes/`, `skills/`, and `scripts/` via path resolution and containment checks.

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

The `schedule` field is a cron expression. When present, Absurd runs the skill automatically via the `execute-skill` task. Skills without a schedule can be triggered manually via `spawn_task("execute-skill", { skillName, chatId })`.

Schedule reconciliation happens at startup and whenever a skill file is written or deleted.

## Testing

```bash
pnpm test
```

Tests are pure unit tests — no database or network required. Co-located with source files as `*.test.ts`.

## Development

```bash
npx tsc --noEmit    # type-check
pnpm test           # run tests
```

There is no build step. TypeScript runs directly via Node 22.18+ native type stripping. The `tsc` script exists only for type-checking in CI. All import paths use `.ts` extensions.
