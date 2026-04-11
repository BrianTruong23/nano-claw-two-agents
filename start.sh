#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$SCRIPT_DIR/.agents.pid"
mkdir -p "$LOG_DIR"

# ── stop command ──────────────────────────────────────────────────────────────
if [[ "${1:-}" == "stop" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    echo "Stopping agents..."
    while IFS= read -r pid; do
      kill "$pid" 2>/dev/null && echo "  Killed PID $pid" || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
    echo "Done."
  else
    echo "No agents running (no PID file found)."
  fi
  pkill -f "nano-claw-agents/.*/dist/index.js" 2>/dev/null || true
  pkill -f "bot-bridge.sh" 2>/dev/null || true
  exit 0
fi

# ── start command (default) ───────────────────────────────────────────────────

# Kill any stale processes from previous runs
if [[ -f "$PID_FILE" ]]; then
  echo "Cleaning up previous run..."
  while IFS= read -r pid; do
    kill "$pid" 2>/dev/null && echo "  Killed stale PID $pid" || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi
pkill -f "nano-claw-agents/.*/dist/index.js" 2>/dev/null || true
pkill -f "bot-bridge.sh" 2>/dev/null || true
sleep 1

echo "Starting Andy..."
nohup bash -c "cd '$SCRIPT_DIR/andy/andy' && exec node dist/index.js" >> "$LOG_DIR/andy.log" 2>&1 &
ANDY_PID=$!

echo "Starting Bob..."
nohup bash -c "cd '$SCRIPT_DIR/bob/bob' && exec node dist/index.js" >> "$LOG_DIR/bob.log" 2>&1 &
BOB_PID=$!

echo "Starting bot-bridge..."
nohup bash "$SCRIPT_DIR/bot-bridge.sh" >> "$LOG_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

# Save PIDs
printf '%s\n' "$ANDY_PID" "$BOB_PID" "$BRIDGE_PID" > "$PID_FILE"

# Disown so agents keep running after this script exits
disown "$ANDY_PID" "$BOB_PID" "$BRIDGE_PID"

echo ""
echo "Agents running in background."
echo "  Andy PID : $ANDY_PID"
echo "  Bob PID  : $BOB_PID"
echo "  Bridge   : $BRIDGE_PID"
echo ""
echo "Logs : $LOG_DIR/andy.log | $LOG_DIR/bob.log | $LOG_DIR/bridge.log"
echo "Stop : ./start.sh stop"
