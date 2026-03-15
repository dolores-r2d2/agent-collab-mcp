#!/usr/bin/env bash
set -euo pipefail

# ── Agent Collaboration Dashboard ────────────────────────────────────────────
# Launches a web UI to visualize task status, activity, and strategy config.
#
# Usage:
#   scripts/dashboard.sh [--port 4800]
# ─────────────────────────────────────────────────────────────────────────────

ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) ARGS+=("--port" "$2"); shift 2 ;;
    -h|--help) head -7 "$0" | tail -5; exit 0 ;;
    *) shift ;;
  esac
done

if [[ ! -f "agent-collab-mcp/build/dashboard.js" ]]; then
  echo "Dashboard not built. Building..."
  (cd agent-collab-mcp && npm run build --silent 2>&1)
fi

if [[ ! -f ".agent-collab/collab.db" ]]; then
  echo "Error: .agent-collab/collab.db not found. Run init.sh first."
  exit 1
fi

exec node agent-collab-mcp/build/dashboard.js ${ARGS[@]+"${ARGS[@]}"}
