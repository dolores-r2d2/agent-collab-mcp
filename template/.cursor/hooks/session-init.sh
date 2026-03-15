#!/usr/bin/env bash
set -euo pipefail

# Lightweight Cursor session-init: directs agent to the MCP server.
# No markdown parsing — the MCP server handles all task state.

DB=".agent-collab/collab.db"

if [[ ! -f "$DB" ]]; then
  cat <<EOF
{
  "agent_message": "STOP: The agent-collab database doesn't exist yet. The project needs initialization. Tell the user to run init.sh from the agent-collab-skeleton."
}
EOF
  exit 0
fi

cat <<EOF
{
  "agent_message": "Call get_my_status from the agent-collab MCP server to see your next task. Do NOT write any code until you have claimed a task."
}
EOF
