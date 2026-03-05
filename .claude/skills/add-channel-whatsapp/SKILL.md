---
name: add-channel-whatsapp
description: Set up WhatsApp as a messaging channel — QR code authentication, configuration, and verification
---

# /add-channel-whatsapp — Add WhatsApp Channel

Walk the user through connecting WhatsApp to everclaw via Baileys (QR code auth). This skill is standalone — run it from `/setup` or anytime to add WhatsApp.

## Instructions

Work through each phase in order. Use `TaskCreate` to track progress. Be autonomous: detect what's already done, only ask questions when a real choice is needed. Use the `Read` and `Edit` tools to modify `.env`.

---

### Phase 1: Preflight

1. Check `.env` exists in the project root. If not, tell the user to run `/setup` first and stop.

2. Read `.env` and check if `CHANNEL_WHATSAPP` is already set.
   - If present, use `AskUserQuestion`:
     > WhatsApp is already configured (`CHANNEL_WHATSAPP` is set in `.env`). What would you like to do?
     > - **Keep it** — Skip to verification
     > - **Reconfigure** — Set up from scratch (will need to re-scan QR code)
   - If "Keep it", skip to Phase 4.
   - If "Reconfigure", tell the user to delete `data/auth/whatsapp/` to clear the old session before proceeding.

---

### Phase 2: Configure

WhatsApp uses QR code authentication — no API token needed. The setup is simpler than token-based channels, but requires an interactive step after the bot starts.

1. Append `CHANNEL_WHATSAPP=1` to `.env` using the `Edit` tool. If reconfiguring, replace the existing line.

2. Ensure the auth directory exists:
   ```bash
   mkdir -p data/auth/whatsapp
   ```

3. Tell the user:

   > **WhatsApp uses QR code authentication.** After restarting the bot, a QR code will be printed in the terminal. You'll scan it with your phone to link the bot to your WhatsApp account.
   >
   > **Important:** This links the bot to your personal WhatsApp. Messages sent to your WhatsApp number will be processed by the bot. The bot only handles direct messages (not group chats).

---

### Phase 3: Restart and QR Scan

This phase combines restart with the interactive QR scan.

Detect the deployment method:
- Check if `docker-compose.yml` exists in the project root.
- If Docker: "Start/restart with `docker compose up --build` — you need to see the terminal output for the QR code."
- If bare metal: "Stop the bot (Ctrl+C) and restart with `node src/index.ts`."

**Important for Docker users:** They need to run in foreground (`docker compose up`, not `-d`) to see the QR code in the terminal.

Walk the user through the QR scan:

> **After starting the bot, watch the terminal for a QR code.** Then:
>
> 1. Open **WhatsApp** on your phone
> 2. Go to **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code shown in the terminal
> 4. Wait for the log message: `WhatsApp connected`
>
> The session is saved to `data/auth/whatsapp/` — you won't need to scan again unless you log out or delete that directory.

Use `AskUserQuestion` to confirm:
> Did you see "WhatsApp connected" in the logs?
> - **Yes** — Continue
> - **No, I see an error** — Help me troubleshoot

If troubleshooting:
- QR code expired → restart to get a new one
- Connection error → check internet connectivity
- "Logged out" error → delete `data/auth/whatsapp/` and restart

---

### Phase 4: Discover chat ID

Check if `ALLOWED_CHAT_IDS` is already configured in `.env` (uncommented and non-empty).

**If not configured (first channel):**

Walk the user through discovery mode:

1. "Send a WhatsApp message to the phone number linked to the bot (from a different phone or WhatsApp account)."
2. "The bot will reply with the sender's chat ID — it looks like `whatsapp:1234567890`. Copy this value."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to set `ALLOWED_CHAT_IDS=<chat_id>` in `.env`. If the line is commented out, uncomment and set it.

**If already configured (adding another channel):**

1. "Send a WhatsApp message to the bot."
2. "The bot will reply with your chat ID. Copy it."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to append the new ID to the existing `ALLOWED_CHAT_IDS` value (comma-separated).

After updating, tell the user to restart again. The QR scan is not needed this time — the session persists.

---

### Phase 5: Verify

1. "Send a test message to the bot on WhatsApp."
2. "The agent should respond this time (not the discovery mode reply)."
3. If it works — congratulations, WhatsApp is set up!
4. If it doesn't respond:
   - Check logs for errors
   - Verify the bot shows "WhatsApp connected" in logs
   - Verify `ALLOWED_CHAT_IDS` contains the right prefixed ID
   - Make sure you're messaging from the allowed phone number
   - Make sure the bot is running

Tell the user they can add more channels later with `/add-channel-telegram`, `/add-channel-discord`, `/add-channel-slack`, or `/add-channel-gmail`.
