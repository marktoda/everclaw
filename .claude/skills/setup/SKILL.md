---
name: setup
description: Walk through first-time setup of absurdclaw — prerequisites, config, database, and verification
---

# /setup — absurdclaw first-time setup

Guide the developer through a complete, working absurdclaw setup. Be autonomous: detect what's already done, fix problems yourself, and only ask questions when a real choice is needed.

## Instructions

Work through each phase in order. Use `TaskCreate` to track progress. Verify each phase before moving to the next. If a step fails, diagnose and fix it — don't just report the error.

---

### Phase 1: Prerequisites

Check the following tools are available. Run the checks in parallel.

1. **Node.js 22.18+** — run `node --version` and parse the semver. If missing or too old, stop and tell the user to install Node 22.18+ (link to https://nodejs.org). This is not something we can install for them.

2. **pnpm** — run `pnpm --version`. If missing, run `corepack enable` then `corepack prepare pnpm@latest --activate` to install it.

3. **Docker & Docker Compose** — run `docker --version` and `docker compose version`. Note availability but don't fail here — the user may choose bare metal.

4. **PostgreSQL client** — run `psql --version`. Note availability for bare metal path.

Report what was found and what was installed.

---

### Phase 2: Choose deployment method

Use `AskUserQuestion` to ask:

> **How do you want to run PostgreSQL?**
>
> - **Docker Compose (Recommended)** — Postgres runs in a container alongside the app. Simplest setup.
> - **Bare metal** — You manage your own PostgreSQL instance. Requires `psql` and a running Postgres server.

If Docker is not installed and user picks Docker, help them understand they need to install Docker first and link to https://docs.docker.com/get-docker/.

---

### Phase 3: Install dependencies

```bash
pnpm install
```

Verify it succeeds (exit code 0, `node_modules/` exists). If it fails:
- Check if `pnpm-lock.yaml` exists — if not, this is expected for a fresh clone
- Check for network errors and retry once
- Check for Node version incompatibility in the error output

---

### Phase 4: Configure `.env`

Check if `.env` already exists in the project root.

**If it exists**, use `AskUserQuestion`:
> A `.env` file already exists. What would you like to do?
> - **Keep it** — Skip configuration, use existing values
> - **Reconfigure** — Create a new `.env` file

**If creating/reconfiguring**, collect secrets using `AskUserQuestion` — one question per secret. NEVER echo secrets to the terminal or pass them as bash arguments. Write the file using the `Write` tool.

1. **TELEGRAM_BOT_TOKEN** (required) — Ask the user to paste their token. Mention they can get one from [@BotFather on Telegram](https://t.me/botfather).

2. **ANTHROPIC_API_KEY** (required) — Ask for their API key. Mention https://console.anthropic.com/settings/keys.

3. **BRAVE_SEARCH_API_KEY** (optional) — Use `AskUserQuestion` to ask if they want web search:
   > Enable web search? Requires a free Brave Search API key (2000 queries/month free).
   > - **Skip for now**
   > - **Add API key**

   If yes, ask for the key. Mention https://brave.com/search/api/.

Write the `.env` file with collected values. Include the comment about Brave being optional. Format:

```
TELEGRAM_BOT_TOKEN=<token>
ANTHROPIC_API_KEY=<key>
# Optional: enables the web_search tool (free tier: 2000 queries/month)
# BRAVE_SEARCH_API_KEY=BSA...
# Chat ID allowlist — leave empty for now; discovery mode will reveal your ID
# ALLOWED_CHAT_IDS=
```

If Brave key was provided, uncomment that line. Leave `ALLOWED_CHAT_IDS` commented out for now — the discovery mode flow in Phase 9 will guide the user to fill it in.

---

### Phase 5: Database setup (bare metal only)

Skip this phase entirely if the user chose Docker — Docker Compose auto-initializes the database via `sql/` mount to `/docker-entrypoint-initdb.d`.

For bare metal:

1. Check the `DATABASE_URL` environment variable. Default is `postgresql://localhost/absurd`. Ask the user if this is correct or if they want a custom URL.

2. Check if the database exists:
   ```bash
   psql "$DATABASE_URL" -c "SELECT 1" 2>&1
   ```
   If it doesn't exist, try to create it:
   ```bash
   createdb absurd
   ```

3. Run the schema migrations:
   ```bash
   psql "$DATABASE_URL" -f sql/001-absurd.sql
   psql "$DATABASE_URL" -f sql/002-assistant.sql
   ```

4. Verify tables were created:
   ```bash
   psql "$DATABASE_URL" -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('absurd', 'assistant')"
   ```

If any step fails, show the error and help diagnose (wrong credentials, Postgres not running, etc).

---

### Phase 6: Ensure writable directories

Create these directories if they don't exist:

```bash
mkdir -p data/notes skills tools
```

These are where the agent stores notes, skill files, and tool scripts at runtime.

---

### Phase 7: Run tests

```bash
pnpm test
```

All tests should pass. They are pure unit tests — no database or network required. If tests fail:
- Read the test output carefully
- Check if it's a dependency issue (re-run `pnpm install`)
- Check if it's a TypeScript version issue
- Fix the issue if possible, or report it clearly

---

### Phase 8: First start

Based on deployment method:

**Docker Compose:**
```bash
docker compose up --build
```
Run this in the background. Wait a few seconds, then check logs for errors. Look for signs the bot connected to Telegram (grammY startup log).

**Bare metal:**
```bash
node src/index.ts
```
Run this in the background. Check output for startup errors. Common issues:
- `.env` missing or malformed — check Phase 4
- Database connection refused — check Postgres is running
- Invalid bot token — check with BotFather

---

### Phase 9: Discover chat ID and enable allowlist

The bot starts in **discovery mode** when `ALLOWED_CHAT_IDS` is not set. Walk the user through:

1. Send any message to the Telegram bot
2. The bot replies with their chat ID and instructions (it does NOT run the agent yet)
3. Copy the chat ID from the reply
4. Add it to `.env`: `ALLOWED_CHAT_IDS=<chat_id>` (uncomment and fill in the value)
5. Restart the bot (Ctrl+C and re-run, or `docker compose restart`)
6. Send another message — this time the agent will respond normally

If the user wants to allow multiple accounts, they can comma-separate IDs: `ALLOWED_CHAT_IDS=123,456`.

### Phase 10: Verify and wrap up

Tell the user:
1. Send a test message to their Telegram bot (after enabling the allowlist)
2. Check the logs to see the message was received and a response was generated

Provide these useful commands:
- **Docker logs:** `docker compose logs -f assistant`
- **Stop (Docker):** `docker compose down`
- **Stop (bare metal):** Ctrl+C in the terminal
- **Run tests:** `pnpm test`
- **Type check:** `npx tsc --noEmit`

Congratulate them — setup is complete.
