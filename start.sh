#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRIPT_DIR
LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$SCRIPT_DIR/.agents.pid"
mkdir -p "$LOG_DIR"

# Keep orchestration logs bounded. By default, each logs/*.log file is capped
# at 50,000 bytes by dropping the oldest bytes and keeping the newest tail.
LOG_MAX_BYTES="${LOG_MAX_BYTES:-50000}"
LOG_TRIM_INTERVAL_SECONDS="${LOG_TRIM_INTERVAL_SECONDS:-30}"
CONVERSATION_RETENTION_DAYS="${CONVERSATION_RETENTION_DAYS:-5}"
CONVERSATION_CLEAN_INTERVAL_SECONDS="${CONVERSATION_CLEAN_INTERVAL_SECONDS:-86400}"

trim_orchestration_logs_to_cap() {
  shopt -s nullglob
  local f size tmp newsize
  for f in "$LOG_DIR"/*.log; do
    [[ -f "$f" ]] || continue
    size=$(wc -c <"$f" | awk '{print $1}')
    if ! [[ "$size" =~ ^[0-9]+$ ]] || ((size <= LOG_MAX_BYTES)); then
      continue
    fi
    tmp="${f}.tmp.$$"
    if tail -c "$LOG_MAX_BYTES" "$f" >"$tmp" 2>/dev/null; then
      newsize=$(wc -c <"$tmp" | awk '{print $1}')
      if [[ "$newsize" =~ ^[0-9]+$ ]] && ((newsize <= LOG_MAX_BYTES)); then
        mv "$tmp" "$f"
        echo "Trimmed $(basename "$f") to ${newsize} bytes (was ${size} bytes)"
      else
        rm -f "$tmp"
      fi
    else
      rm -f "$tmp"
    fi
  done
  shopt -u nullglob
}

cleanup_conversation_archives() {
  python3 - <<'PY'
import os, time

repo = os.environ.get("SCRIPT_DIR") or os.getcwd()
days_raw = os.environ.get("CONVERSATION_RETENTION_DAYS", "5")
try:
    days = int(days_raw)
except Exception:
    days = 5
days = max(0, days)
cutoff = time.time() - (days * 86400)

deleted = 0
scanned = 0

for agent in ("andy", "bob"):
    base = os.path.join(repo, agent, "groups")
    if not os.path.isdir(base):
        continue
    for root, dirs, files in os.walk(base):
        # Only operate on .../groups/<folder>/conversations
        if os.path.basename(root) != "conversations":
            continue
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            scanned += 1
            try:
                st = os.stat(path)
            except FileNotFoundError:
                continue
            # Delete if older than cutoff by mtime.
            if st.st_mtime < cutoff:
                try:
                    os.remove(path)
                    deleted += 1
                except Exception:
                    pass

print(f"Conversation cleanup: scanned={scanned} deleted={deleted} retention_days={days}")
PY
}

start_log_trimmer_loop() {
  local last_conv_clean=0
  while true; do
    trim_orchestration_logs_to_cap || true
    now=$(date +%s)
    if (( now - last_conv_clean >= CONVERSATION_CLEAN_INTERVAL_SECONDS )); then
      # Best-effort cleanup; never fail the loop.
      cleanup_conversation_archives || true
      last_conv_clean=$now
    fi
    sleep "$LOG_TRIM_INTERVAL_SECONDS"
  done
}

if [[ "${1:-}" == "log-trimmer-loop" ]]; then
  start_log_trimmer_loop
  exit 0
fi

# ── logs-clean ───────────────────────────────────────────────────────────────
# Truncate orchestration logs (andy/bob/bridge) so they do not grow without bound.
# Stop agents first so new log files are used cleanly after restart.
if [[ "${1:-}" == "logs-clean" ]]; then
  force=false
  [[ "${2:-}" == "--force" ]] && force=true

  if [[ -f "$PID_FILE" ]] && [[ "$force" != "true" ]]; then
    alive=()
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      if kill -0 "$pid" 2>/dev/null; then
        alive+=("$pid")
      fi
    done < "$PID_FILE"
    if ((${#alive[@]} > 0)); then
      echo "Agents still running (PIDs: ${alive[*]})." >&2
      echo "Stop them first:  ./start.sh stop" >&2
      echo "Then clear logs:   ./start.sh logs-clean" >&2
      echo "Or truncate anyway (same open files keep writing until restart): ./start.sh logs-clean --force" >&2
      exit 1
    fi
    rm -f "$PID_FILE"
  fi

  shopt -s nullglob
  cleared=0
  for f in "$LOG_DIR"/*.log; do
    : >"$f"
    echo "Cleared $f"
    cleared=$((cleared + 1))
  done
  shopt -u nullglob
  if ((cleared == 0)); then
    echo "No *.log files in $LOG_DIR"
  fi
  echo "Done."
  exit 0
fi

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
  echo "Trimming logs to ${LOG_MAX_BYTES} bytes per file…"
  trim_orchestration_logs_to_cap || true
echo "Cleaning conversation archives older than ${CONVERSATION_RETENTION_DAYS} days…"
cleanup_conversation_archives || true
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
echo "Trimming logs to ${LOG_MAX_BYTES} bytes per file…"
trim_orchestration_logs_to_cap || true
echo "Cleaning conversation archives older than ${CONVERSATION_RETENTION_DAYS} days…"
cleanup_conversation_archives || true

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

ensure_agent_dependencies() {
  local root="$1"
  local name
  name="$(basename "$root")"
  if [[ ! -x "$root/node_modules/.bin/tsc" ]] || [[ ! -d "$root/node_modules/@onecli-sh/sdk" ]] || [[ ! -d "$root/node_modules/better-sqlite3" ]]; then
    echo "Installing $name dependencies (node_modules missing or incomplete)..."
    (cd "$root" && npm ci)
  fi
  if (cd "$root" && node -e "require('esbuild'); const Database = require('better-sqlite3'); new Database(':memory:').close();") >/dev/null 2>&1; then
    return
  fi
  echo "Reinstalling $name dependencies (native package failed to load on this platform)..."
  (cd "$root" && npm ci)
  (cd "$root" && node -e "require('esbuild'); const Database = require('better-sqlite3'); new Database(':memory:').close();") >/dev/null
}

# Rebuild when dist is missing, incomplete, or older than any src/*.ts (avoids ERR_MODULE_NOT_FOUND after pulls).
ensure_agent_build() {
  local root="$1"
  local name
  name="$(basename "$root")"
  ensure_agent_dependencies "$root"
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

# setsid(1) is common on Linux for a clean new session; macOS does not ship it.
# Without a fallback, nohup fails immediately and agents never stay up.
launch_background() {
  local log_file="$1"
  shift
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$@" >>"$log_file" 2>&1 &
  else
    nohup "$@" >>"$log_file" 2>&1 &
  fi
}

echo "Starting Andy..."
launch_background "$LOG_DIR/andy.log" bash -c "cd '$SCRIPT_DIR/andy' && exec node dist/index.js"
ANDY_PID=$!

echo "Starting Bob..."
launch_background "$LOG_DIR/bob.log" bash -c "cd '$SCRIPT_DIR/bob' && exec node dist/index.js"
BOB_PID=$!

echo "Starting bot-bridge..."
launch_background "$LOG_DIR/bridge.log" bash "$SCRIPT_DIR/bot-bridge.sh"
BRIDGE_PID=$!

echo "Starting log trimmer..."
launch_background "$LOG_DIR/log-trimmer.log" bash "$SCRIPT_DIR/start.sh" log-trimmer-loop
TRIMMER_PID=$!

# Save PIDs
printf '%s\n' "$ANDY_PID" "$BOB_PID" "$BRIDGE_PID" "$TRIMMER_PID" > "$PID_FILE"

# Disown so agents keep running after this script exits
disown "$ANDY_PID" "$BOB_PID" "$BRIDGE_PID" "$TRIMMER_PID"

echo ""
echo "Agents running in background."
echo "  Andy PID : $ANDY_PID"
echo "  Bob PID  : $BOB_PID"
echo "  Bridge   : $BRIDGE_PID"
echo "  Trimmer  : $TRIMMER_PID"
echo ""
echo "Logs : $LOG_DIR/andy.log | $LOG_DIR/bob.log | $LOG_DIR/bridge.log"
echo "Stop : ./start.sh stop  (logs are capped at ${LOG_MAX_BYTES} bytes automatically)"
echo "Full clear: ./start.sh logs-clean"
