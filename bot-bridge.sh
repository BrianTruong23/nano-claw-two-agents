#!/usr/bin/env bash
# Bridges outgoing messages between Andy and Bob so each bot can see
# the other's replies in its AI context (Telegram doesn't deliver bot-to-bot).
# Messages are written as is_bot_message=1 so they appear in context
# but don't trigger a new agent response (preventing infinite loops).

ANDY_DB="/Users/tht0021/Documents/nano-claw-agents/andy/andy/store/messages.db"
BOB_DB="/Users/tht0021/Documents/nano-claw-agents/bob/bob/store/messages.db"
GROUP_JID="tg:-5122778581"

echo "[bridge] Started — syncing messages between Andy and Bob"

while true; do
  # Andy → Bob: copy Andy's outgoing messages into Bob's DB
  sqlite3 "$BOB_DB" \
    "ATTACH DATABASE '$ANDY_DB' AS source;
     INSERT OR IGNORE INTO main.messages
       (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     SELECT
       'xbot_andy_' || id,
       '$GROUP_JID',
       'tg:user:andy_bot',
       'Andy (other bot)',
       '[Context from Andy bot - previous reply in this group]' || char(10) || content,
       timestamp,
       0,
       1
     FROM source.messages
     WHERE chat_jid='$GROUP_JID' AND is_from_me=1
     ORDER BY timestamp ASC;
     DETACH DATABASE source;" 2>/dev/null || true

  # Bob → Andy: copy Bob's outgoing messages into Andy's DB
  sqlite3 "$ANDY_DB" \
    "ATTACH DATABASE '$BOB_DB' AS source;
     INSERT OR IGNORE INTO main.messages
       (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     SELECT
       'xbot_bob_' || id,
       '$GROUP_JID',
       'tg:user:bob_bot',
       'Bob (other bot)',
       '[Context from Bob bot - previous reply in this group]' || char(10) || content,
       timestamp,
       0,
       1
     FROM source.messages
     WHERE chat_jid='$GROUP_JID' AND is_from_me=1
     ORDER BY timestamp ASC;
     DETACH DATABASE source;" 2>/dev/null || true

  sleep 2
done
