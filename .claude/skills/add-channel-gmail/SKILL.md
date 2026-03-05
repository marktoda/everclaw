---
name: add-channel-gmail
description: Set up Gmail as a messaging channel — Google OAuth2, credentials, token exchange, and verification
---

# /add-channel-gmail — Add Gmail Channel

Walk the user through connecting Gmail to everclaw via Google OAuth2. This skill is standalone — run it from `/setup` or anytime to add Gmail. This is the most involved channel setup.

## Instructions

Work through each phase in order. Use `TaskCreate` to track progress. Be autonomous: detect what's already done, only ask questions when a real choice is needed. Use the `Read` and `Edit` tools to modify `.env`. NEVER echo secrets to the terminal or pass them as bash arguments.

---

### Phase 1: Preflight

1. Check `.env` exists in the project root. If not, tell the user to run `/setup` first and stop.

2. Read `.env` and check if `CHANNEL_GMAIL` is already set.
   - If present, use `AskUserQuestion`:
     > Gmail is already configured (`CHANNEL_GMAIL` is set in `.env`). What would you like to do?
     > - **Keep it** — Skip to verification
     > - **Reconfigure** — Set up from scratch (will need to re-authorize)
   - If "Keep it", skip to Phase 4.
   - If "Reconfigure", tell the user to delete `data/auth/gmail/` to clear old credentials before proceeding.

---

### Phase 2: Configure — Google Cloud Console

Walk the user through creating OAuth2 credentials. This has many steps but each is straightforward.

1. Tell the user:

   > **Create a Google Cloud project and enable the Gmail API:**
   >
   > 1. Go to the [Google Cloud Console](https://console.cloud.google.com)
   > 2. Click the project dropdown at the top and select **New Project**
   > 3. Name it (e.g., "everclaw") and click **Create**
   > 4. Make sure the new project is selected
   > 5. Go to **APIs & Services → Library** (left sidebar)
   > 6. Search for **Gmail API** and click **Enable**
   >
   > **Configure the OAuth consent screen:**
   >
   > 7. Go to **APIs & Services → OAuth consent screen**
   > 8. Select **External** user type (unless you have a Google Workspace org)
   > 9. Fill in the required fields (app name, user support email, developer contact email)
   > 10. Click **Save and Continue** through the remaining steps
   > 11. Under **Test users**, add the Gmail address you want the bot to use
   >
   > **Create OAuth2 credentials:**
   >
   > 12. Go to **APIs & Services → Credentials**
   > 13. Click **Create Credentials → OAuth client ID**
   > 14. Application type: **Desktop app** (or **Web application** if you prefer)
   > 15. Name it and click **Create**
   > 16. Click **Download JSON** to download the credentials file

2. Use `AskUserQuestion`:
   > **Did you download the credentials JSON file?** Paste the full path to the downloaded file (e.g., `~/Downloads/client_secret_123.json`).

3. Copy the credentials file to the auth directory:
   ```bash
   mkdir -p data/auth/gmail
   cp "<user_provided_path>" data/auth/gmail/credentials.json
   ```

4. Append `CHANNEL_GMAIL=1` to `.env` using the `Edit` tool. If reconfiguring, replace the existing line.

---

### Phase 3: Restart and OAuth2 Authorization

This phase combines restart with the interactive OAuth2 flow.

Detect the deployment method:
- Check if `docker-compose.yml` exists in the project root.
- If Docker: "Start/restart with `docker compose up --build` — you need to see the terminal output for the OAuth URL."
- If bare metal: "Stop the bot (Ctrl+C) and restart with `node src/index.ts`."

**Important for Docker users:** They need to run in foreground to see the OAuth URL.

After restart, the Gmail adapter will print an OAuth2 authorization URL and then throw an error (this is expected on first run). Walk the user through the token exchange:

> **Complete the OAuth2 authorization:**
>
> 1. Look in the logs for a URL starting with `https://accounts.google.com/o/oauth2/v2/auth?...`
> 2. Open that URL in your browser
> 3. Sign in with the Gmail account the bot should use
> 4. Click **Allow** to grant access (you may see a "This app isn't verified" warning — click **Advanced → Go to [app name]**)
> 5. After authorization, you'll be redirected. Copy the **authorization code** from the URL or page.
> 6. Exchange it for a token by running this command (replace the placeholders):
>
> ```bash
> curl -s -d "code=AUTH_CODE&client_id=YOUR_CLIENT_ID&client_secret=YOUR_SECRET&redirect_uri=YOUR_REDIRECT_URI&grant_type=authorization_code" https://oauth2.googleapis.com/token
> ```
>
> You can find your client_id, client_secret, and redirect_uri in `data/auth/gmail/credentials.json`.

Use `AskUserQuestion`:
> **Paste the JSON response from the curl command** (it contains access_token and refresh_token).

Read the response, validate it looks like a token response (has `access_token`), and save it:

```bash
# Write the token using the Write tool — do NOT echo it to the terminal
```

Use the `Write` tool to save the token JSON to `data/auth/gmail/token.json`.

Tell the user to restart the bot again. This time the Gmail adapter should connect successfully — look for "Gmail connected" in the logs.

---

### Phase 4: Discover chat ID

Check if `ALLOWED_CHAT_IDS` is already configured in `.env` (uncommented and non-empty).

**If not configured (first channel):**

Walk the user through discovery mode:

1. "Send an email to the Gmail address connected to the bot (from a different email address)."
2. "The bot will reply with the sender's chat ID — it looks like `gmail:sender@example.com`. Check the bot's logs or outgoing email for this."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to set `ALLOWED_CHAT_IDS=<chat_id>` in `.env`. If the line is commented out, uncomment and set it.

**If already configured (adding another channel):**

1. "Send an email to the bot's Gmail address."
2. "The bot will reply with your chat ID. Check the logs or outgoing email."
3. Use `AskUserQuestion` to collect the chat ID.
4. Use the `Edit` tool to append the new ID to the existing `ALLOWED_CHAT_IDS` value (comma-separated).

After updating, tell the user to restart again.

---

### Phase 5: Verify

1. "Send a test email to the bot's Gmail address."
2. "Within 30 seconds (the polling interval), the agent should process it and send a reply email."
3. If it works — congratulations, Gmail is set up!
4. If it doesn't respond:
   - Check logs for errors
   - Verify "Gmail connected" appears in startup logs
   - Verify `data/auth/gmail/token.json` exists and contains a refresh_token
   - Verify `data/auth/gmail/credentials.json` is valid
   - Verify `ALLOWED_CHAT_IDS` contains the right prefixed ID (e.g., `gmail:sender@example.com`)
   - Make sure the bot is running
   - Note: Gmail polls every 30 seconds — responses aren't instant

Tell the user they can add more channels later with `/add-channel-telegram`, `/add-channel-discord`, `/add-channel-slack`, or `/add-channel-whatsapp`.
