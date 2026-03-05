---
name: add-channel-telegram
description: Set up Telegram as a messaging channel — bot token, configuration, and verification
---

# /add-channel-telegram — Add Telegram Channel

Walk the user through connecting a Telegram bot to everclaw. This skill is standalone — run it from `/setup` or anytime to add Telegram.

## Instructions

Work through each phase in order. Use `TaskCreate` to track progress. Be autonomous: detect what's already done, only ask questions when a real choice is needed. NEVER echo secrets to the terminal or pass them as bash arguments — use the `Read` and `Edit` tools to modify `.env`.

---

### Phase 1: Preflight

1. Check `.env` exists in the project root. If not, tell the user to run `/setup` first and stop.

2. Read `.env` and check if `CHANNEL_TELEGRAM` is already set.
   - If present, use `AskUserQuestion`:
     > Telegram is already configured (`CHANNEL_TELEGRAM` is set in `.env`). What would you like to do?
     > - **Keep it** — Skip to verification
     > - **Reconfigure** — Replace with a new bot token
   - If "Keep it", skip to Phase 4.

---

### Phase 2: Configure

1. Use `AskUserQuestion` to collect the bot token:

   > **Paste your Telegram bot token.**
   >
   > To get one:
   > 1. Open Telegram and message [@BotFather](https://t.me/botfather)
   > 2. Send `/newbot` and follow the prompts
   > 3. Copy the token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

2. Append `CHANNEL_TELEGRAM=<token>` to `.env` using the `Edit` tool. If reconfiguring, replace the existing `CHANNEL_TELEGRAM` line.

---

### Phase 3: Restart

Detect the deployment method and tell the user how to restart:

- Check if `docker-compose.yml` exists in the project root.
- If Docker: "Restart the bot with `docker compose restart` (or `docker compose up --build` if not running)."
- If bare metal: "Stop the bot (Ctrl+C) and restart with `node src/index.ts`."

Tell the user to restart now and wait for them to confirm it's running. Look for startup logs indicating the Telegram adapter connected.

---

### Phase 4: Discover chat ID

Check if `ALLOWED_CHAT_IDS` is already configured in `.env` (uncommented and non-empty).

**If not configured (first channel):**

Walk the user through discovery mode:

1. "Send any message to your Telegram bot."
2. "The bot will reply with your chat ID — it looks like `telegram:123456789`. Copy this value."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to set `ALLOWED_CHAT_IDS=<chat_id>` in `.env`. If the line is commented out, uncomment and set it.

**If already configured (adding another channel):**

1. "Send any message to your Telegram bot."
2. "The bot will reply with your chat ID. Copy it."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to append the new ID to the existing `ALLOWED_CHAT_IDS` value (comma-separated).

After updating, tell the user to restart again (same instructions as Phase 3).

---

### Phase 5: Verify

1. "Send a test message to your Telegram bot."
2. "The agent should respond this time (not the discovery mode reply)."
3. If it works — congratulations, Telegram is set up!
4. If it doesn't respond:
   - Check logs for errors
   - Verify the bot token is correct
   - Verify `ALLOWED_CHAT_IDS` contains the right prefixed ID
   - Make sure the bot is running

Tell the user they can add more channels later with `/add-channel-discord`, `/add-channel-slack`, `/add-channel-whatsapp`, or `/add-channel-gmail`.
