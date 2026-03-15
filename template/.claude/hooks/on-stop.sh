#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null

# Lightweight Claude Code stop hook: in full-auto mode, triggers Cursor to fix
# changes-requested tasks.

DB=".agent-collab/collab.db"

if [[ ! -f "$DB" ]] || ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

changes_task=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE status = 'changes-requested' ORDER BY updated_at DESC LIMIT 1" 2>/dev/null || echo "")

if [[ -z "$changes_task" ]]; then
  exit 0
fi

if [[ "${AGENT_COLLAB_FULL_AUTO:-}" == "1" ]] && command -v agent &>/dev/null; then
  mkdir -p scripts/logs
  agent -p --force --workspace . \
    "Call get_my_status from agent-collab MCP. Claim task $changes_task, read the review feedback, fix the issues, and submit for review." \
    > "scripts/logs/fix-${changes_task}-$(date +%s).log" 2>&1 || true

  new_status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id = '$changes_task'")
  if [[ "$new_status" == "review" ]]; then
    jq -n --arg task "$changes_task" '{
      followup_message: ("Task " + $task + " has been fixed and resubmitted for review. Call get_my_status and review it again.")
    }'
  fi
fi
