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

# NanoClaw reads `.env` from each agent directory (cwd). Seed from repo-root templates if missing.
sync_agent_env() {
  local agent_dir="$1"
  local template="$2"
  local name
  name="$(basename "$agent_dir")"
  if [[ -f "$agent_dir/.env" ]]; then
    return 0
  fi
  if [[ -f "$template" ]]; then
    cp "$template" "$agent_dir/.env"
    echo "Created $name/.env from $(basename "$template")"
    return 0
  fi
  echo "ERROR: $name/.env is missing and template not found: $template" >&2
  echo "  Copy your secrets to $agent_dir/.env (see README Quick Start)." >&2
  exit 1
}
sync_agent_env "$SCRIPT_DIR/andy" "$SCRIPT_DIR/.env_andy"
sync_agent_env "$SCRIPT_DIR/bob" "$SCRIPT_DIR/.env_bob"

# Rebuild when dist is missing, incomplete, or older than any src/*.ts (avoids ERR_MODULE_NOT_FOUND after pulls).
ensure_agent_build() {
  local root="$1"
  local name
  name="$(basename "$root")"
  if [[ ! -f "$root/dist/index.js" ]] || [[ ! -f "$root/dist/claude-runner.js" ]]; then
    echo "Building $name (dist missing or incomplete)..."
    (cd "$root" && npm run build)
    return
  fi
  if find "$root/src" -name '*.ts' -newer "$root/dist/index.js" 2>/dev/null | grep -q .; then
    echo "Building $name (TypeScript newer than dist)..."
    (cd "$root" && npm run build)
  fi
}
ensure_agent_build "$SCRIPT_DIR/andy"
ensure_agent_build "$SCRIPT_DIR/bob"

echo "Starting Andy..."
nohup bash -c "cd '$SCRIPT_DIR/andy' && exec node dist/index.js" >> "$LOG_DIR/andy.log" 2>&1 &
ANDY_PID=$!

echo "Starting Bob..."
nohup bash -c "cd '$SCRIPT_DIR/bob' && exec node dist/index.js" >> "$LOG_DIR/bob.log" 2>&1 &
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
