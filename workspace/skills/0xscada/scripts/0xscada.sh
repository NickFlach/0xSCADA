#!/usr/bin/env bash
# 0xSCADA CLI wrapper

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCADA_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"   # repo root
PORT="${SCADA_PORT:-5000}"
BASE_URL="http://localhost:$PORT"

is_running() {
  if curl -sf "$BASE_URL/api/health" > /dev/null; then
    return 0
  fi
  return 1
}

cmd_start() {
  if is_running; then
    echo "0xSCADA already running"
    return 0
  fi

  echo "Starting 0xSCADA..."
  cd "$SCADA_DIR"
  npm run dev &
  sleep 5

  if is_running; then
    echo "0xSCADA started successfully on $BASE_URL"
  else
    echo "Failed to start 0xSCADA"
    exit 1
  fi
}

cmd_status() {
  if is_running; then
    echo "0xSCADA is RUNNING on $BASE_URL"
  else
    echo "0xSCADA is STOPPED"
  fi
}

CMD="${1:-status}"
shift || true

case "$CMD" in
  start)       cmd_start "$@" ;;
  status)      cmd_status ;;
  *)
    echo "Usage: 0xscada.sh <command> [args]"
    echo "Commands:"
    echo "  start     Start the 0xSCADA server"
    echo "  status    Show running status"
    exit 1
    ;;
esac
