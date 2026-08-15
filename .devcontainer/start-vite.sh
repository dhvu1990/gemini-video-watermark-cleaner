#!/usr/bin/env bash
set -euo pipefail

PORT="${GEMINI_VITE_PORT:-5173}"
LOG_FILE="${GEMINI_VITE_LOG:-/tmp/gemini-vite.log}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_URL="http://127.0.0.1:${PORT}/"

if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
  exit 0
fi

: > "$LOG_FILE"

# Dev Container lifecycle shells may be terminated immediately after
# postStartCommand finishes. setsid -f creates a new session so Vite remains
# alive after that lifecycle shell exits.
setsid -f bash -lc "cd '$ROOT_DIR' && exec npm run dev -- --host 0.0.0.0 --port '$PORT'" \
  </dev/null >>"$LOG_FILE" 2>&1

for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.25
done

echo "Vite did not become healthy on port ${PORT}. Log follows:" >&2
cat "$LOG_FILE" >&2 || true
exit 1
