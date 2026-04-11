# Telegram Group Chat Monitor Setup

How to connect a Claude Code session to the NanoClaw Telegram group so you can monitor and participate in the chat alongside the bot.

## Prerequisites

- `TELEGRAM-TOKEN` must be set in `.env` (already present as `NanoClawBot1`)
- The bot must already be a member of the target group
- NanoClaw must be running and the group must be registered (see Step 4)

## Known group

- Title: `Brian, Nanobot and NanoAssistant2Bot`
- Chat ID: `-5122778581`
- NanoClaw JID: `tg:-5122778581`
- Trigger: `@Andy`

## Step 1 — Read the bot token

```bash
grep "TELEGRAM-TOKEN" .env
```

The token format is `<bot_id>:<secret>`.

## Step 2 — Find the group chat ID

If the group ID is unknown, fetch recent updates. The bot must have received at least one message from the group.

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep -E '"id"|"title"|"type"'
```

Look for `"type": "group"` or `"type": "supergroup"`. The `"id"` on that chat object is your `CHAT_ID` (negative number).

> **Warning:** If NanoClaw is running it will race with this call for `getUpdates`. Stop the agent before running this, or read from the `chats` table in the DB instead:
> ```bash
> sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE is_group=1;"
> ```

## Step 3 — Ensure the group is registered with NanoClaw

NanoClaw only stores and processes messages from **registered** groups. Check registration:

```bash
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups;"
```

If the group is missing, register it:

```bash
# 1. Create the group folder
mkdir -p groups/telegram_group/logs

# 2. Insert the registration row
sqlite3 store/messages.db "INSERT OR IGNORE INTO registered_groups \
  (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main) \
  VALUES ('tg:-5122778581', 'Brian, Nanobot and NanoAssistant2Bot', \
  'telegram_group', '@Andy', datetime('now'), 1, 0);"

# 3. Restart the agent so it loads the new registration
#    (registration is read at startup, not live-reloaded)
curl -s -X POST http://127.0.0.1:4780/api/agent/stop
curl -s -X POST http://127.0.0.1:4780/api/agent/start
```

> If the agent was started outside the dashboard, kill it first:
> `kill -SIGTERM <pid>` then start via dashboard.

## Step 4 — Start the DB monitor

The correct approach is to watch NanoClaw's SQLite database, not poll Telegram directly. This avoids racing with NanoClaw for `getUpdates`.

**Important:** Use the DB for the NanoClaw process you are monitoring. In this multi-agent repo, Andy uses `andy/store/messages.db` and Bob uses `bob/store/messages.db` (repo root = directory that contains both `andy/` and `bob/`). If you have other NanoClaw installs on disk, confirm with `ps` which `cwd` is running:

```bash
ps aux | grep "dist/index\|src/index" | grep -v grep
```

Then watch its DB (example: Bob — from repo root, or set `REPO` yourself):

```
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DB="$REPO/bob/store/messages.db"
LAST_ID=$(sqlite3 "$DB" "SELECT MAX(CAST(id AS INTEGER)) FROM messages WHERE chat_jid='tg:-5122778581';" 2>/dev/null || echo 0)
[ -z "$LAST_ID" ] && LAST_ID=0

while true; do
  ROWS=$(sqlite3 "$DB" "SELECT id, sender_name, content, timestamp FROM messages WHERE chat_jid='tg:-5122778581' AND CAST(id AS INTEGER) > $LAST_ID ORDER BY CAST(id AS INTEGER) ASC;" 2>/dev/null)
  while IFS='|' read -r id name content ts; do
    [ -z "$id" ] && continue
    dt=$(echo "$ts" | sed 's/T/ /' | sed 's/\..*//' | sed 's/Z//' | awk -F'[- :]' '{printf "%s:%s:%s UTC", $4, $5, $6}')
    echo "[$dt] $name: $content"
    LAST_ID=$id
  done <<< "$ROWS"
  sleep 2
done
```

Monitor tool parameters:
- `description`: `Telegram group chat monitor — Brian, Nanobot and NanoAssistant2Bot`
- `persistent`: `true`
- `timeout_ms`: `3600000`

Each new message arrives as a notification:
```
[18:38:43 UTC] Brian Truong: @Andy hello
```

> Messages only appear once NanoClaw processes them. The group must be registered and the agent must be running.

## Sending a reply

```bash
curl -s -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": -5122778581, "text": "your message here"}'
```

## Notes

- Messages in the group only reach the agent if they contain the trigger (`@Andy` by default).
- The DB monitor polls every 2 seconds — latency is at most ~2s after NanoClaw stores the message.
- Use `TaskStop <task_id>` to cancel the monitor.
- If the bot token is rotated, update `.env` and restart NanoClaw.
- The `store/messages.db` path is relative to the NanoClaw install root. The `data/nanoclaw.db` file holds tasks and scheduled jobs; `store/messages.db` holds chat messages.
