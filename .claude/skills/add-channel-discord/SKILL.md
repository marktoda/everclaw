---
name: add-channel-discord
description: Set up Discord as a messaging channel — bot creation, gateway intents, and verification
---

# /add-channel-discord — Add Discord Channel

Walk the user through connecting a Discord bot to everclaw. This skill is standalone — run it from `/setup` or anytime to add Discord.

## Instructions

Work through each phase in order. Use `TaskCreate` to track progress. Be autonomous: detect what's already done, only ask questions when a real choice is needed. NEVER echo secrets to the terminal or pass them as bash arguments — use the `Read` and `Edit` tools to modify `.env`.

---

### Phase 1: Preflight

1. Check `.env` exists in the project root. If not, tell the user to run `/setup` first and stop.

2. Read `.env` and check if `CHANNEL_DISCORD` is already set.
   - If present, use `AskUserQuestion`:
     > Discord is already configured (`CHANNEL_DISCORD` is set in `.env`). What would you like to do?
     > - **Keep it** — Skip to verification
     > - **Reconfigure** — Replace with a new bot token
   - If "Keep it", skip to Phase 4.

---

### Phase 2: Configure

Walk the user through creating a Discord bot:

1. Tell the user:

   > **Create a Discord bot application:**
   >
   > 1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   > 2. Click **New Application** and give it a name
   > 3. Go to the **Bot** section in the left sidebar
   > 4. Click **Reset Token** (or **Add Bot** if it's a new app) and copy the token
   >
   > **Important — Enable these Gateway Intents** (same page, scroll down):
   > - ✅ **Message Content Intent**
   > - ✅ **Server Members Intent** (optional but recommended)
   >
   > Without Message Content Intent enabled, the bot cannot read message text and will silently ignore all messages.

2. Use `AskUserQuestion` to collect the bot token:
   > **Paste your Discord bot token.**

3. Append `CHANNEL_DISCORD=<token>` to `.env` using the `Edit` tool. If reconfiguring, replace the existing line.

4. Help the user invite the bot to their server. Tell them:

   > **Invite the bot to your Discord server:**
   >
   > 1. In the Developer Portal, go to **OAuth2 → URL Generator**
   > 2. Select scopes: **bot**
   > 3. Select permissions: **Send Messages**, **Read Message History**
   > 4. Copy the generated URL and open it in your browser
   > 5. Select the server to add the bot to and authorize

---

### Phase 3: Restart

Detect the deployment method and tell the user how to restart:

- Check if `docker-compose.yml` exists in the project root.
- If Docker: "Restart the bot with `docker compose restart` (or `docker compose up --build` if not running)."
- If bare metal: "Stop the bot (Ctrl+C) and restart with `node src/index.ts`."

Tell the user to restart now and wait for them to confirm it's running. Look for "Discord adapter started" in the logs.

---

### Phase 4: Discover chat ID

Check if `ALLOWED_CHAT_IDS` is already configured in `.env` (uncommented and non-empty).

**If not configured (first channel):**

Walk the user through discovery mode:

1. "Send a message in any channel where the bot is present (or DM the bot directly)."
2. "The bot will reply with your chat ID — it looks like `discord:123456789`. Copy this value."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to set `ALLOWED_CHAT_IDS=<chat_id>` in `.env`. If the line is commented out, uncomment and set it.

**If already configured (adding another channel):**

1. "Send a message to the bot on Discord."
2. "The bot will reply with your chat ID. Copy it."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to append the new ID to the existing `ALLOWED_CHAT_IDS` value (comma-separated).

After updating, tell the user to restart again (same instructions as Phase 3).

---

### Phase 5: Verify

1. "Send a test message to the bot on Discord."
2. "The agent should respond this time (not the discovery mode reply)."
3. If it works — congratulations, Discord is set up!
4. If it doesn't respond:
   - Check logs for errors
   - Verify **Message Content Intent** is enabled in the Developer Portal
   - Verify the bot token is correct
   - Verify the bot has been invited to the server
   - Verify `ALLOWED_CHAT_IDS` contains the right prefixed ID
   - Make sure the bot is running

Tell the user they can add more channels later with `/add-channel-telegram`, `/add-channel-slack`, `/add-channel-whatsapp`, or `/add-channel-gmail`.
