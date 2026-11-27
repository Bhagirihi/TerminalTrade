#!/bin/bash
# V3 loop service helper — start / watchdog / stop / status.
#
# The loop itself decides everything (token, market hours, resume); this
# script only makes sure exactly one copy runs, detached from any terminal,
# logging to logs/v3-<date>.log. Cron calls `watchdog` every 5 minutes on
# weekdays; the watchdog starts the loop only while the market is open
# (IST) and only when no loop is already running.
#
#   start     — start the loop now (no-op if one is already running)
#   watchdog  — start it if the market is open and none is running
#   stop      — SIGTERM the running loop, service or hand-started (it squares off, then exits)
#   status    — is it running? + the tail of today's log
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$REPO/logs"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/v3-$(TZ=Asia/Calcutta date +%F).log"

# node is not always on cron's PATH — look in the usual places.
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for c in /usr/local/bin/node /usr/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

# The loop's command line is `node tools/start.js` (plus --service for
# the service copy) — but the service starts it through the absolute node
# path (`/usr/bin/node ...`), and the path to start.js is relative, so
# the match must allow an optional `/.../` before `node` and an optional
# `<dir>/` before `tools/start.js`. It still requires `node` to be the
# command itself (start of line or right after a `/`), so a shell whose
# command merely mentions the path (a grep, a --check, an editor) never
# counts as a running loop. The old patterns anchored on `^node` and
# demanded a `/tools/` prefix, so they never matched a real loop at all.
LOOP_PATTERN='(^|/)node ([^ ]*/)?tools/start\.js( --service)?$'
SERVICE_PATTERN='(^|/)node ([^ ]*/)?tools/start\.js --service$'

is_running() { pgrep -f "$LOOP_PATTERN" >/dev/null 2>&1; }
running_pid() { pgrep -f "$LOOP_PATTERN" | head -1; }

do_start() {
  if is_running; then
    echo "V3 loop already running (pid $(running_pid))."
    return 0
  fi
  local node
  node="$(find_node)" || { echo "node not found — cannot start the V3 loop." >&2; return 1; }
  cd "$REPO" || return 1
  nohup "$node" tools/start.js --service >> "$LOG" 2>&1 &
  disown
  echo "V3 loop started (pid $!). Log: $LOG"
}

do_watchdog() {
  local node
  node="$(find_node)" || exit 1
  # Market open? (IST, Mon–Fri 09:00–15:30 — the loop's own rule.)
  # Requiring start.js is side-effect-free: main() only runs when the
  # file is the entry point.
  if ! "$node" -e "const {marketOpen} = require('$REPO/tools/start.js'); process.exit(marketOpen(Date.now()) ? 0 : 1);"; then
    exit 0
  fi
  if is_running; then exit 0; fi
  do_start
}

do_stop() {
  local pid
  pid="$(running_pid)" || true
  if [ -z "$pid" ]; then
    echo "V3 loop is not running."
    return 0
  fi
  if pgrep -f "$SERVICE_PATTERN" >/dev/null 2>&1; then
    echo "Stopping the V3 service loop (pid $pid)..."
  else
    # A hand-started loop holds the same lockfile, so "stop" must end it
    # too — the old service-only check reported "not running" while the
    # loop was alive and every new start kept refusing.
    echo "Stopping the V3 loop (pid $pid) — it was started by hand, not as a service."
  fi
  pkill -TERM -f "$LOOP_PATTERN"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    is_running || { echo "V3 loop stopped."; return 0; }
    sleep 1
  done
  echo "V3 loop did not stop in 10s — check the log: $LOG"
  return 1
}

do_status() {
  if is_running; then
    echo "V3 loop running (pid $(running_pid))."
  else
    echo "V3 loop not running."
  fi
  if [ -f "$LOG" ]; then
    echo "--- today's log ($LOG), last 12 lines ---"
    tail -12 "$LOG"
  else
    echo "No log yet today."
  fi
}

case "${1:-status}" in
  start) do_start ;;
  watchdog) do_watchdog ;;
  stop) do_stop ;;
  status) do_status ;;
  *) echo "Usage: $0 {start|watchdog|stop|status}" >&2; exit 2 ;;
esac
