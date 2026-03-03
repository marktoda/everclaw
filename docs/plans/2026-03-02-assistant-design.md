# Everclaw: Agent as Workflow Author

An AI personal assistant built on Absurd — a durable task queue with
checkpointing, sleep, events, and scheduling. The agent doesn't just answer
questions; it authors and manages long-lived workflows. A reminder is a
sleeping task. A daily summary is a scheduled skill. A deployment pipeline
is a polling loop that survives restarts. Everything is a workflow.

Telegram is the communication channel. The entire agent runs inside a Docker
container for security. The agent extends itself by writing files — skill
templates, tool scripts, and notes — using the same generic file tools for
everything.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Project location | Separate repository | Depends on Absurd TS SDK as a package |
| LLM backend | Claude API (Anthropic SDK) | Direct tool use, aligns with ecosystem |
| Architecture | Absurd-native | Every interaction is a durable workflow |
| Workflow primitives | Agent tools map to `ctx.sleepFor`/`awaitEvent`/`emitEvent`/`spawn` | Every conversation is a durable workflow; nanoclaw can't do this |
| User interaction | Stateless turns via conversation history | Every message spawns fresh task; no routing complexity |
| Deployment | Entire agent in Docker | OS-level containment; no nested containers |
| Extensibility | Skills (markdown) + tool scripts | Agent can self-extend without code deployments |
| File tools | Generic `read_file`/`write_file`/`list_files`/`delete_file` | Same tools for notes, skills, and any writable directory |
| Schedule management | `syncSchedules` reconciliation | One idempotent function replaces scattered create/delete calls |
| Conversation history | Postgres table | Queryable, transactional |
| State storage | Postgres KV table | Simple get/set JSONB for workflow context |
| Scheduling | Absurd's built-in cron system | No external scheduler needed |
| Telegram library | grammY (long-polling) | No public endpoint required |
| Interaction model | All natural language | No slash commands; agent handles everything |
| Multi-user | Single user only | Simplifies auth, memory, permissions |
| Text delivery | Send text blocks to Telegram per-turn | User sees each turn's text immediately, not after full tool chain |
| Internal reasoning | `<internal>` tags stripped from output | Agent can think without leaking to user; still visible in logs |
| Secrets | `.env` mounted read-only, parsed in-process, never set as env vars | Tool scripts can't exfiltrate credentials |

## System Architecture

```
Host machine
  |
  +-- Docker container (everclaw)
  |     |
  |     +-- Node.js process
  |     |     +-- Telegram bot (grammY, long-polling)
  |     |     +-- Absurd worker (claims and executes tasks)
  |     |     +-- Agent loop (Claude API + tool dispatch)
  |     |
  |     +-- data/                      (writable volume)
  |     |     +-- notes/               agent notes (markdown files)
  |     +-- skills/*.md                (writable volume)
  |     +-- tools/*                    (writable volume)
  |     +-- Network: Telegram API, Claude API, Postgres
  |
  +-- PostgreSQL
        +-- absurd schema (queues, tasks, runs, checkpoints, schedules, events)
        +-- assistant schema (messages, state)
```

Single Absurd queue (`assistant`) for all tasks. The container provides
OS-level security — the agent can modify its own files but cannot affect
the host.

## Everything Is a Workflow

The agent's core differentiator is durable workflows. Every interaction runs
as a checkpointed Absurd task that can sleep, wait, spawn subtasks, and
survive restarts. The same mechanism handles all patterns:

| Pattern | Implementation | Example |
|---------|---------------|---------|
| Conversation | `handle-message` task with agent loop | "What's the weather?" |
| One-shot reminder | `sleep_until` within a task | "Remind me at 5pm" |
| Polling loop | `sleep_for` loop within a task | "Watch this PR" |
| Background work | `spawn_task("workflow", ...)` | "Deploy staging in background" |
| Recurring behavior | Skill file with `schedule` frontmatter | "Daily GitHub summary" |
| User confirmation | State store + new task | "Delete these files?" → "yes" |

**Key principle**: The agent never suspends to wait for user input. Every
Telegram message spawns a fresh `handle-message` task. Conversation history
and the state store provide continuity across turns. For user confirmations,
the agent asks its question, saves workflow context to the state store, and
lets the task complete. The user's reply arrives as a new message — the new
task reads history + state and continues.

### Task Types

| Task | Purpose |
|------|---------|
| `handle-message` | Process a Telegram message (may become a long-lived workflow) |
| `execute-skill` | Run a skill's workflow instructions |
| `send-message` | Send a proactive Telegram message |
| `workflow` | Generic sub-workflow spawned by the agent |

### How Durable Workflows Work

When the agent calls a workflow tool (`sleep_for`, `sleep_until`,
`wait_for_event`), the executor calls the corresponding `TaskContext` method.
If the wake condition isn't met, `ctx` throws `SuspendTask` — the worker
slot is released and no resources are consumed while sleeping. When the
condition is met, Absurd reclaims the task, replays all checkpointed steps,
and the agent continues from where it left off.

Each Claude API call is a checkpointed step. If the worker crashes
mid-conversation, it resumes from the last completed LLM call (no duplicate
API spend).

### Events

Events (`wait_for_event`/`emit_event`) are for **task-to-task coordination
only** — not for user interaction. Absurd events are persistent one-shot
latches: once emitted, any future wait on the same name returns immediately.
This makes them ideal for signaling completion between tasks (e.g., a
spawned workflow emitting `done:{taskId}` when finished) but unsuitable
as a message channel.

The agent manages its own event naming conventions through its notes file.

## Skills (Workflow Templates)

Skills are markdown files that describe recurring or on-demand workflows.
The agent creates and manages them using generic file tools. Each skill
has YAML frontmatter and markdown instructions.

```markdown
---
name: daily-todo-summary
description: Send a daily summary of active TODOs every morning
schedule: "0 9 * * *"
---

# Daily TODO Summary

When this skill's schedule fires:

1. Read the TODO list from state (key: "todos")
2. Format as a numbered list with priorities
3. Send the summary to the user via Telegram
4. Call out any overdue items
```

Skills with a `schedule` field are automatically registered as Absurd
schedules that spawn `execute-skill` tasks. Skills without a schedule are
invoked on-demand during conversations when the agent determines they're
relevant.

### Schedule Reconciliation

A single `syncSchedules()` function manages all skill-based schedules. It
compares skill files' frontmatter against Absurd's schedule registry and
creates, updates, or deletes schedules to reconcile. Called on startup and
after any write or delete to the `skills/` directory.

```
syncSchedules(absurd, skillsDir, chatId):
  desired = read all skills with schedule frontmatter
  existing = absurd.listSchedules() filtered to "skill:*" prefix
  for each desired: create or update if missing/changed
  for each existing not in desired: delete (orphan cleanup)
```

This eliminates standalone schedule CRUD tools. The agent writes a skill
file and the system handles the rest.

## Tool Scripts (Executable Capabilities)

Tool scripts are executable files (shell, Python, etc.) that the agent
creates and invokes. They run inside the container with a timeout.

```bash
#!/bin/bash
# tools/github-prs.sh
# Input: JSON on stdin with { owner, repo }
input=$(cat)
owner=$(echo "$input" | jq -r '.owner')
repo=$(echo "$input" | jq -r '.repo')
gh pr list --repo "$owner/$repo" --json title,url,author --limit 10
```

Tool scripts receive JSON on stdin and write results to stdout. They
execute with `timeout 30s` inside the container.

## Agent Tools

15 tools in 4 categories.

### File Tools

Generic file operations. The agent uses the same tools for notes, skills,
and tool scripts. Directory-aware side effects are applied automatically:
writes to `skills/` trigger `syncSchedules()`, writes to `tools/` auto
`chmod +x`.

| Tool | Purpose |
|------|---------|
| `read_file` | Read a file from any writable directory |
| `write_file` | Write/overwrite a file (triggers side effects by directory) |
| `list_files` | List files in a directory |
| `delete_file` | Delete a file (triggers side effects by directory) |

### State Tools

| Tool | Purpose |
|------|---------|
| `get_state` | Read from the Postgres KV store |
| `set_state` | Write to the Postgres KV store |
| `get_status` | Uptime, file counts, schedule count |

### Script Tools

| Tool | Purpose |
|------|---------|
| `run_script` | Execute a tool script with JSON input |

### Orchestration Tools

| Tool | Purpose |
|------|---------|
| `sleep_for` | Suspend task for N seconds, resume where you left off |
| `sleep_until` | Suspend until a specific datetime |
| `spawn_task` | Spawn independent sub-task/workflow |
| `cancel_task` | Cancel a running or sleeping task |
| `list_tasks` | List active/sleeping tasks |
| `wait_for_event` | Suspend until a named event (task-to-task coordination) |
| `emit_event` | Emit event that wakes waiting tasks |

### How Self-Extension Works

**Example: "Give me a daily summary of my GitHub PRs every morning"**

1. Agent writes `tools/github-prs.sh` via `write_file` (auto `chmod +x`)
2. Agent writes `skills/morning-pr-check.md` via `write_file`:
   ```markdown
   ---
   name: morning-pr-check
   description: Check GitHub PRs and send a morning summary
   schedule: "0 9 * * *"
   ---
   Run the github-prs tool for my repos, summarize open PRs,
   and notify me if any need review.
   ```
3. `syncSchedules()` fires automatically, creates Absurd schedule
4. Every morning at 9am, the skill executes as a durable workflow

**Example: "Remind me to buy milk at 5pm"**

1. Agent calls `sleep_until("reminder-milk", "2024-03-15T17:00:00Z")`
2. Task suspends, worker slot released
3. At 5pm, Absurd reclaims task, agent resumes
4. Agent sends "Reminder: buy milk!"
5. Task completes

No schedule needed for one-shot reminders.

**Example: "Deploy to staging, wait for health check, then deploy prod"**

1. Agent runs `deploy-staging.sh` via `run_script`
2. Agent calls `sleep_for("check-1", 30)` — suspends 30s
3. Resumes, runs health check script — not ready
4. Agent calls `sleep_for("check-2", 30)` — suspends again
5. Resumes, health check passes — runs tests — pass
6. Agent deploys to prod, polls health similarly
7. Sends "Deployment complete!"

**Example: "Delete all old log files" (user confirmation)**

1. Agent finds 47 files, sends "Found 47 old log files. Delete them?"
2. Agent saves `set_state("workflow", "pending-action", {action: "delete-logs", files: [...]})`
3. Task completes
4. User replies "yes" — new `handle-message` task
5. New task sees the question + "yes" in conversation history
6. Reads `get_state("workflow", "pending-action")` — gets file list
7. Deletes files, clears state, sends confirmation

## Message Flow

1. User sends a Telegram message
2. grammY handler spawns `handle-message` task with message payload
3. Absurd worker claims the task
4. **Step "load-context"**: Read notes, query last N messages,
   discover available skills and tools
5. **Step "agent-turn-{i}"** (checkpointed per iteration):
   - Call Claude API with system prompt + history + tools
   - **Send text blocks to Telegram per-turn** (not token-level streaming —
     the user sees each turn's output immediately rather than waiting for
     the full tool chain to finish)
   - If Claude returns tool_use: execute the tool (checkpointed via
     `ctx.step()` for non-suspending tools)
   - If Claude returns a workflow tool (`sleep_for`, `sleep_until`,
     `wait_for_event`): the executor calls the corresponding `ctx`
     method **without a wrapping `ctx.step()`** — the SDK manages its
     own internal checkpoints. If the wake condition isn't met,
     `SuspendTask` is thrown, the worker slot is released. When the
     condition is met, Absurd reclaims the task and the agent resumes.
   - Append tool result, loop back to Claude
6. **Step "persist"**: Save all messages to history (user message,
   assistant text, tool_use blocks, and tool results)

### Text Delivery & Output Filtering

Agent text blocks are sent to Telegram per-turn — after each Claude API
call completes, not token-by-token. The user sees each turn's output
immediately rather than waiting for the full tool chain to finish. Before
sending, outbound text is filtered:

- `<internal>...</internal>` tags are stripped. The agent can use these
  for scratchpad reasoning that shouldn't reach the user.
- This gives the agent a structured way to think/plan without leaking
  intermediate reasoning, while keeping it debuggable in logs.

## Memory & State

### Agent Notes (`data/notes/`)

A directory of markdown files the agent reads on every message and updates
when it learns something meaningful. Human-editable and git-trackable.
Managed via the same `read_file`/`write_file` tools used for everything else.

```markdown
# data/notes/profile.md
- Name: ...
- Timezone: ...
- Communication style: ...

# data/notes/preferences.md
- ...

# data/notes/context.md
- ...
```

**Why files, not Postgres?** Agent notes are read in full every time, never
queried or filtered. A file read is simpler than a DB query for this access
pattern. The user can edit notes from the host via the mounted volume.

### Conversation History (Postgres)

```sql
CREATE SCHEMA IF NOT EXISTS assistant;

CREATE TABLE IF NOT EXISTS assistant.messages (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content     TEXT NOT NULL,
  tool_use    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat
  ON assistant.messages(chat_id, created_at DESC);
```

### State Store (Postgres KV)

Generic key-value store for workflow context, skill data, and tool state.

```sql
CREATE TABLE IF NOT EXISTS assistant.state (
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);
```

The `namespace` field scopes state by purpose (e.g., `"workflow"`,
`"skill:daily-todo-summary"`, `"tool:github-prs"`).

### Context Window Strategy

When building the Claude prompt:

1. Always include: system instructions + agent notes + tool definitions
2. Include relevant skill descriptions (one-liners for discovery)
3. Fill remaining context with recent messages (newest first)
4. If history exceeds budget, summarize older messages into a "Previously..."
   block (itself a checkpointed step)

## Security Model

### Secret Hygiene

The `.env` file is mounted read-only into the container. The application
reads it at startup using a `readEnvFile()` helper that parses key-value
pairs but **never sets `process.env`**. Secrets exist only as in-memory
variables — tool scripts inherit the container's environment, which
contains no secrets.

This prevents a misbehaving tool script or skill from exfiltrating
credentials via `env` or `/proc/self/environ`.

### Container Isolation

The entire assistant runs inside a Docker container:

- **Non-root user** inside the container
- **Mounted volumes** for `data/`, `skills/`, `tools/` (persistent, inspectable from host)
- **Network access** limited to Telegram API, Claude API, and Postgres
- **No Docker socket** mounted (no container-in-container)
- **Read-only application code** (only data/, skills/, tools/ are writable)
- **No secret env vars** — secrets read from mounted `.env` file, never set in environment

### Blast Radius

If the agent misbehaves, the worst case is:
- It corrupts its own skills/notes — delete the volumes and restart
- It sends unwanted Telegram messages — revoke the bot token
- It writes garbage to Postgres — the assistant schema is isolated from absurd schema

It cannot access the host filesystem, other services, or escape the container.
It cannot access API keys or tokens via environment variables.

### Tool Script Safety

- Scripts execute with `timeout 30s` (configurable)
- Scripts run as the non-root container user
- Network access within the container (same as the agent itself)
- **No access to secrets** — environment is clean
- The user can inspect/edit tool scripts from the host via the mounted volume

## System Prompt Structure

```
[Base personality and instructions]
[Workflow capabilities guide]
[Contents of data/notes/*.md]
[Available skill descriptions (one-liners)]
[Available tool script descriptions]
[Current date/time]
---
[Last N messages from conversation history]
```

## Project Structure

```
everclaw/
  src/
    index.ts              # Entry: init Absurd, bot, worker
    config.ts             # Config from .env file
    bot.ts                # grammY bot setup
    tasks/
      handle-message.ts   # Main agent loop task
      execute-skill.ts    # Scheduled skill execution task
      send-message.ts     # Proactive outbound message task
      workflow.ts         # Generic sub-workflow task
    agent/
      loop.ts             # Claude API agent loop logic
      prompt.ts           # System prompt assembly
      tools.ts            # All tool definitions (15 tools)
      executor.ts         # Tool dispatch (files + state + scripts + orchestration)
      output.ts           # Internal tag stripping
    memory/
      history.ts          # Postgres message history CRUD
      state.ts            # Postgres KV store
    skills/
      manager.ts          # Skill discovery, frontmatter parsing, syncSchedules
    scripts/
      runner.ts           # Tool script execution (with timeout)
  skills/                  # Skill files (writable volume)
    (agent creates these at runtime)
  tools/                   # Tool scripts (writable volume)
    (agent creates these at runtime)
  data/
    notes/                # Agent notes (writable volume)
  sql/
    001-absurd.sql        # Absurd schema (queues, tasks, runs, checkpoints, schedules, events)
    002-assistant.sql     # Assistant schema (messages, state)
  package.json
  tsconfig.json
  Dockerfile
  docker-compose.yml      # Assistant + Postgres
```

### Dependencies

- `absurd-sdk` — Absurd TypeScript SDK
- `grammy` — Telegram Bot API
- `@anthropic-ai/sdk` — Claude API

No `dockerode` or `chokidar` needed. The agent runs inside Docker (managed
externally) and tool scripts run via `child_process.execFile`.

## Deployment

```yaml
# docker-compose.yml
services:
  assistant:
    build: .
    restart: unless-stopped
    volumes:
      - ./data:/app/data
      - ./skills:/app/skills
      - ./tools:/app/tools
      - ./.env:/app/.env:ro
    environment:
      # Only non-secret config as env vars
      - DATABASE_URL=postgresql://postgres:postgres@db/absurd
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./sql:/docker-entrypoint-initdb.d
    environment:
      - POSTGRES_DB=absurd
      - POSTGRES_PASSWORD=postgres
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

## Open Questions

- **Skill sharing**: Should skills be installable from a URL or git repo?
- **Multi-channel**: When adding channels beyond Telegram, should they be
  separate bot instances or a unified adapter layer?
- **Context window management**: What's the right threshold for triggering
  conversation summarization? Token count vs message count?
- **Agent notes consolidation**: Should this be automatic (periodic) or
  user-initiated?
