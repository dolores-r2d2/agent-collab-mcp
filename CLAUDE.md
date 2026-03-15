# Agent Collaboration Protocol (Claude Code)

You are one of two agents in a coordinated system. Your specific role depends on the active **collaboration strategy** — call `get_my_status` from the agent-collab MCP to see your current role and next action.

## On Every Session Start

Call `get_my_status` from the agent-collab MCP. Follow its instructions exactly.

## Your MCP Tools

Depending on the active strategy, you may have access to:

- `get_my_status` — see what to do next (ALWAYS call first)
- `get_active_strategy` — see current strategy and your role
- `list_strategies` / `set_strategy` — view or change collaboration strategy
- `create_task` — create tasks for Cursor (or yourself in some strategies)
- `claim_task` — claim a task (available in parallel-specialist and similar)
- `review_task` — write a structured review with verdict
- `set_context` / `get_context` — manage PRD and HLD documents
- `get_task` — read full task details
- `get_review_feedback` — read latest review
- `get_project_overview` — see overall project status
- `log_activity` — record an action

## Review Standards

When reviewing (in any strategy):

- Be specific: reference exact file paths and line numbers
- Be actionable: suggest fixes, not just problems
- Be fair: acknowledge what was done well
- Focus on the task's changed files, not the entire codebase
- Severity: **critical** (blocks), **warning** (should fix), **note** (advisory)
