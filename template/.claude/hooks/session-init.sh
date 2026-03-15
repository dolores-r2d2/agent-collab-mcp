#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null

# Lightweight Claude Code session-init: directs agent to the MCP server.

DB=".agent-collab/collab.db"

if [[ ! -f "$DB" ]]; then
  exit 0
fi

if ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

review_count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status = 'review'")

if [[ "$review_count" -gt 0 ]]; then
  review_ids=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE status = 'review' ORDER BY id" | tr '\n' ', ' | sed 's/,$//')
  jq -n --arg tasks "$review_ids" '{
    addToSystemPrompt: ("Tasks awaiting review: " + $tasks + ". Call get_my_status from agent-collab MCP, then review each task.")
  }'
fi
