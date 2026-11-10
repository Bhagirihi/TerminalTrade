#!/usr/bin/env bash
# Runs the whole dashboard on this phone (Termux). The browser on the same phone opens it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${TERMUX_VERSION:-}" ]] && command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock >/dev/null 2>&1 || true' EXIT
fi

if [[ ! -d node_modules/express ]]; then
  npm install
fi

export HOST=127.0.0.1
echo "Open http://127.0.0.1:${PORT:-3000} in this phone's browser."
echo "Keep Termux open while the market is on."
exec node src/server.js
