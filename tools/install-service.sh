#!/bin/bash
# Install the V3 weekday watchdog cron (idempotent — safe to run again).
#
# One cron line, every 5 minutes Mon–Fri:
#   <repo>/tools/v3-service.sh watchdog
# The watchdog itself checks market hours (IST) and whether a loop is
# already running, so no timezone maths is needed in the crontab: it
# starts the loop around 09:00 IST, restarts it if it ever dies mid-day,
# and does nothing after 15:30 or on weekends.
#
# Morning routine stays: log in once (npm run login) so a fresh token is
# in .env. The watchdog then starts the loop on its own — no terminal
# needs to stay open. The first run of the day must be interactive
# (npm run start) to set the mode and budget; after that the service
# resumes that session on its own.
#
#   --dry-run   print the cron line instead of installing it.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="# v3-watchdog"
LINE="*/5 * * * 1-5 bash $REPO/tools/v3-service.sh watchdog $MARKER"
mkdir -p "$REPO/logs"

if command -v node >/dev/null 2>&1; then NODE="$(command -v node)"
elif [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node
elif [ -x /usr/bin/node ]; then NODE=/usr/bin/node
else NODE="$(ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1 || true)"; fi
echo "node: ${NODE:-not found (the service script will look again at runtime)}"
echo "repo: $REPO"

if [ "${1:-}" = "--dry-run" ]; then
  echo "would install:"
  echo "  $LINE"
  exit 0
fi

( crontab -l 2>/dev/null | grep -v "$MARKER" || true; echo "$LINE" ) | crontab -
echo "installed:"
crontab -l | grep "$MARKER" || true
echo "Logs: $REPO/logs/v3-<date>.log"
echo "Check it with: bash $REPO/tools/v3-service.sh status"
echo "Stop it with:  bash $REPO/tools/v3-service.sh stop"
