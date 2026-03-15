#!/usr/bin/env bash
set -euo pipefail

# Cursor stop hook: checks if any task moved to review.
# In 'both' mode, triggers Claude Code for cross-review.
# In single-engine mode, prompts Cursor to self-review.

DB=".agent-collab/collab.db"

if [[ ! -f "$DB" ]] || ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

review_count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status = 'review'")

if [[ "$review_count" -eq 0 ]]; then
  exit 0
fi

review_task=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE status = 'review' ORDER BY updated_at DESC LIMIT 1")

engine_mode=$(sqlite3 "$DB" "SELECT COALESCE((SELECT value FROM config WHERE key = 'engine_mode'), 'both')")

if [[ "$engine_mode" == "cursor-only" ]]; then
  cat <<FOLLOWUP
{
  "followup_message": "Task $review_task is ready for self-review. Call get_my_status, then review_task(\"$review_task\", ...) with your verdict."
}
FOLLOWUP
  exit 0
fi

if command -v claude &>/dev/null; then
  mkdir -p scripts/logs
  claude -p --permission-mode auto \
    "Call get_my_status from the agent-collab MCP. Then get_task(\"$review_task\") to see details. Review the implementation files and call review_task with your verdict." \
    > "scripts/logs/review-${review_task}-$(date +%s).log" 2>&1 || true

  new_status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id = '$review_task'")
  if [[ "$new_status" == "changes-requested" ]]; then
    cat <<FOLLOWUP
{
  "followup_message": "Review feedback received for $review_task. Call get_review_feedback(\"$review_task\") to see the issues and fix them."
}
FOLLOWUP
  elif [[ "$new_status" == "done" ]]; then
    cat <<FOLLOWUP
{
  "followup_message": "Task $review_task approved! Call get_my_status to see your next task."
}
FOLLOWUP
  fi
fi
