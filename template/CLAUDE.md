# Agent Collaboration Protocol (Claude Code)

You are part of a coordinated agent system. Your specific role depends on the active **collaboration strategy** and **engine mode** — call `get_my_status` from the agent-collab MCP to see your current role and next action.

In single-engine mode (`claude-code-only`), you handle **both** Primary and Secondary roles with all tools available.

## On Every Session Start

Call `get_my_status` from the agent-collab MCP. Follow its instructions exactly.

## Your MCP Tools

Depending on the active strategy and engine mode, you may have access to:

- `get_my_status` — see what to do next (ALWAYS call first)
- `get_active_strategy` — see current strategy, engine mode, and your role
- `list_strategies` / `set_strategy` — view or change collaboration strategy
- `set_engine_mode` — switch between both/cursor-only/claude-code-only
- `create_task` — create tasks with detailed specs
- `claim_task` — claim a task (in single-engine mode or parallel strategies)
- `submit_for_review` — submit completed work
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
