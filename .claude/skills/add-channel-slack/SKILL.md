---
name: add-channel-slack
description: Set up Slack as a messaging channel — app creation, Socket Mode, dual tokens, and verification
---

# /add-channel-slack — Add Slack Channel

Walk the user through connecting a Slack app to everclaw via Socket Mode. This skill is standalone — run it from `/setup` or anytime to add Slack.

## Instructions

Work through each phase in order. Use `TaskCreate` to track progress. Be autonomous: detect what's already done, only ask questions when a real choice is needed. NEVER echo secrets to the terminal or pass them as bash arguments — use the `Read` and `Edit` tools to modify `.env`.

---

### Phase 1: Preflight

1. Check `.env` exists in the project root. If not, tell the user to run `/setup` first and stop.

2. Read `.env` and check if `CHANNEL_SLACK` is already set.
   - If present, use `AskUserQuestion`:
     > Slack is already configured (`CHANNEL_SLACK` is set in `.env`). What would you like to do?
     > - **Keep it** — Skip to verification
     > - **Reconfigure** — Replace with new tokens
   - If "Keep it", skip to Phase 4.

---

### Phase 2: Configure

Walk the user through creating a Slack app with Socket Mode. This is the most involved token-based setup.

1. Tell the user:

   > **Create a Slack app:**
   >
   > 1. Go to [Slack API — Your Apps](https://api.slack.com/apps)
   > 2. Click **Create New App → From scratch**
   > 3. Name it and select your workspace
   >
   > **Enable Socket Mode:**
   >
   > 4. Go to **Settings → Socket Mode** (left sidebar)
   > 5. Toggle **Enable Socket Mode** on
   > 6. When prompted, create an **App-Level Token** with the `connections:write` scope
   > 7. Copy the app token (starts with `xapp-`)
   >
   > **Create a Bot Token:**
   >
   > 8. Go to **OAuth & Permissions** (left sidebar)
   > 9. Under **Scopes → Bot Token Scopes**, add:
   >    - `chat:write`
   >    - `app_mentions:read`
   > 10. Click **Install to Workspace** at the top and authorize
   > 11. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
   >
   > **Subscribe to Events:**
   >
   > 12. Go to **Event Subscriptions** (left sidebar)
   > 13. Toggle **Enable Events** on
   > 14. Under **Subscribe to bot events**, add:
   >     - `message.channels` (messages in public channels)
   >     - `message.im` (direct messages)
   > 15. Click **Save Changes**
   >
   > You may need to reinstall the app after adding event subscriptions.

2. Use `AskUserQuestion` to collect the bot token:
   > **Paste your Slack Bot User OAuth Token** (starts with `xoxb-`).

3. Use `AskUserQuestion` to collect the app token:
   > **Paste your Slack App-Level Token** (starts with `xapp-`).

4. Validate both tokens have the expected prefixes. If not, warn the user and ask them to double-check.

5. Append `CHANNEL_SLACK=<bot_token>|<app_token>` to `.env` using the `Edit` tool (pipe-delimited, no spaces). If reconfiguring, replace the existing line.

---

### Phase 3: Restart

Detect the deployment method and tell the user how to restart:

- Check if `docker-compose.yml` exists in the project root.
- If Docker: "Restart the bot with `docker compose restart` (or `docker compose up --build` if not running)."
- If bare metal: "Stop the bot (Ctrl+C) and restart with `node src/index.ts`."

Tell the user to restart now and wait for them to confirm it's running. The Slack adapter connects via Socket Mode — no public URL needed.

---

### Phase 4: Discover chat ID

Check if `ALLOWED_CHAT_IDS` is already configured in `.env` (uncommented and non-empty).

**If not configured (first channel):**

Walk the user through discovery mode:

1. "Send a direct message to the bot on Slack, or mention it in a channel where it's been added."
2. "The bot will reply with your chat ID — it looks like `slack:C04ABC123`. Copy this value."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to set `ALLOWED_CHAT_IDS=<chat_id>` in `.env`. If the line is commented out, uncomment and set it.

**If already configured (adding another channel):**

1. "Send a message to the bot on Slack."
2. "The bot will reply with your chat ID. Copy it."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to append the new ID to the existing `ALLOWED_CHAT_IDS` value (comma-separated).

After updating, tell the user to restart again (same instructions as Phase 3).

---

### Phase 5: Verify

1. "Send a test message to the bot on Slack."
2. "The agent should respond this time (not the discovery mode reply)."
3. If it works — congratulations, Slack is set up!
4. If it doesn't respond:
   - Check logs for errors
   - Verify both tokens are correct (bot token starts with `xoxb-`, app token starts with `xapp-`)
   - Verify Socket Mode is enabled
   - Verify event subscriptions are configured (`message.channels`, `message.im`)
   - Verify `ALLOWED_CHAT_IDS` contains the right prefixed ID
   - Make sure the bot is running

Tell the user they can add more channels later with `/add-channel-telegram`, `/add-channel-discord`, `/add-channel-whatsapp`, or `/add-channel-gmail`.
