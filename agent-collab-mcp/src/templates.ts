/**
 * Embedded template files for project scaffolding.
 * Used by the setup_project tool when installing via npx (no template/ directory available).
 */

export interface TemplateFile {
  path: string;
  content: string;
  executable?: boolean;
}

export function getCursorTemplates(): TemplateFile[] {
  return [
    { path: ".cursor/mcp.json", content: CURSOR_MCP_JSON },
    { path: ".cursor/hooks.json", content: CURSOR_HOOKS_JSON },
    { path: ".cursor/hooks/session-init.sh", content: CURSOR_SESSION_INIT, executable: true },
    { path: ".cursor/hooks/on-stop.sh", content: CURSOR_ON_STOP, executable: true },
    { path: ".cursor/hooks/enforce-task.sh", content: CURSOR_ENFORCE_TASK, executable: true },
    { path: ".cursor/rules/agent-collab.mdc", content: CURSOR_RULE },
    { path: "AGENTS.md", content: AGENTS_MD },
    { path: "scripts/dashboard.sh", content: DASHBOARD_SH, executable: true },
    { path: "scripts/orchestrate.sh", content: ORCHESTRATE_SH, executable: true },
    { path: ".githooks/pre-commit", content: PRE_COMMIT_HOOK, executable: true },
  ];
}

export function getClaudeTemplates(): TemplateFile[] {
  return [
    { path: ".claude/settings.json", content: CLAUDE_SETTINGS },
    { path: ".claude/hooks/session-init.sh", content: CLAUDE_SESSION_INIT, executable: true },
    { path: ".claude/hooks/on-stop.sh", content: CLAUDE_ON_STOP, executable: true },
    { path: ".claude/agents/task-reviewer.md", content: CLAUDE_TASK_REVIEWER },
    { path: ".claude/agents/architect.md", content: CLAUDE_ARCHITECT },
    { path: "CLAUDE.md", content: CLAUDE_MD },
  ];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Cursor templates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CURSOR_MCP_JSON = `{
  "mcpServers": {
    "agent-collab": {
      "command": "npx",
      "args": ["-y", "agent-collab-mcp@latest"],
      "env": {
        "AGENT_ROLE": "cursor",
        "AGENT_ENGINE_MODE": "both"
      }
    }
  }
}
`;

const CURSOR_HOOKS_JSON = `{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": ".cursor/hooks/session-init.sh"
      }
    ],
    "afterFileEdit": [
      {
        "command": ".cursor/hooks/enforce-task.sh"
      }
    ],
    "stop": [
      {
        "command": ".cursor/hooks/on-stop.sh"
      }
    ]
  }
}
`;

const CURSOR_SESSION_INIT = `#!/usr/bin/env bash
set -euo pipefail

DB=".agent-collab/collab.db"

if [[ ! -f "$DB" ]]; then
  cat <<EOF
{
  "agent_message": "Call get_my_status from the agent-collab MCP server. The project needs initial setup — the MCP will walk you through it."
}
EOF
  exit 0
fi

cat <<EOF
{
  "agent_message": "Call get_my_status from the agent-collab MCP server to see your next task. Do NOT write any code until you have claimed a task."
}
EOF
`;

const CURSOR_ON_STOP = `#!/usr/bin/env bash
set -euo pipefail

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
  "followup_message": "Task $review_task is ready for self-review. Call get_my_status, then review_task(\\"$review_task\\", ...) with your verdict."
}
FOLLOWUP
  exit 0
fi

if command -v claude &>/dev/null; then
  mkdir -p scripts/logs
  claude -p --permission-mode auto \\
    "Call get_my_status from the agent-collab MCP. Then get_task(\\"$review_task\\") to see details. Review the implementation files and call review_task with your verdict." \\
    > "scripts/logs/review-\${review_task}-$(date +%s).log" 2>&1 || true

  new_status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id = '$review_task'")
  if [[ "$new_status" == "changes-requested" ]]; then
    cat <<FOLLOWUP
{
  "followup_message": "Review feedback received for $review_task. Call get_review_feedback(\\"$review_task\\") to see the issues and fix them."
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
`;

const CURSOR_ENFORCE_TASK = `#!/usr/bin/env bash
# afterFileEdit hook: fires after every file edit by the Cursor agent.
# Enforces the MCP workflow — blocks rogue edits in "both" mode.
set -euo pipefail

# Consume stdin (Cursor passes file edit details)
cat > /dev/null

DB=".agent-collab/collab.db"

# Skip if agent-collab not set up or sqlite3 missing
if [[ ! -f "$DB" ]] || ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

# Only enforce in "both" mode
engine_mode=$(sqlite3 "$DB" "SELECT value FROM config WHERE key = 'engine_mode'" 2>/dev/null || echo "")
if [[ "$engine_mode" != "both" ]]; then
  exit 0
fi

# Check if Claude Code (Architect) has been involved
hld_exists=$(sqlite3 "$DB" "SELECT COUNT(*) FROM context WHERE key = 'hld'" 2>/dev/null || echo "0")
total_tasks=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks" 2>/dev/null || echo "0")

# If no HLD and no tasks — Cursor never called invoke_architect
if [[ "$hld_exists" -eq 0 && "$total_tasks" -eq 0 ]]; then
  cat <<'EOF'
{
  "agent_message": "STOP. You are in 'both' mode — Claude Code is the Architect. You MUST call invoke_architect('describe what the user wants') BEFORE writing any code. Do NOT create tasks or architecture yourself. Do NOT continue editing files until the Architect has created the HLD and tasks."
}
EOF
  exit 0
fi

# Tasks exist — check if one is claimed
in_progress=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status = 'in-progress'" 2>/dev/null || echo "0")

if [[ "$in_progress" -eq 0 ]]; then
  cat <<'EOF'
{
  "agent_message": "STOP. You are editing files without claiming a task. Call claim_task(task_id) from the agent-collab MCP before making any more changes. Run get_my_status to see available tasks."
}
EOF
fi
`;

const CURSOR_RULE = `---
description: Agent collaboration protocol via MCP
alwaysApply: true
---

# Agent Collaboration — Automated Workflow

You have the agent-collab MCP configured. Follow the MCP workflow strictly:

1. Call \`get_my_status\` to check your role, available tools, and next action
2. If setup is needed, call \`setup_project(project_dir)\` — do NOT pass engine_mode
3. If no tasks exist:
   - In cursor-only mode: create HLD with \`set_context("hld", ...)\` then tasks with \`create_task\`
   - In both mode: call \`invoke_architect("what the user wants built")\` to have Claude Code design and create tasks
4. For each assigned task: \`claim_task\` -> \`get_task\` -> implement -> \`submit_for_review\`
5. After submitting for review in "both" mode, call \`trigger_review()\` to auto-invoke the reviewer
6. Check \`get_my_status\` after reviews — if changes-requested, \`claim_task\` again, fix, resubmit
7. When all tasks are done, suggest \`archive_epic\` to the user to clear the board

## MANDATORY Rules

- NEVER write code without claiming a task first via \`claim_task\`
- NEVER skip the MCP workflow even if the user says "just build it"
- NEVER pass engine_mode to setup_project or call set_engine_mode
- The \`get_my_status\` response lists your available tools — only call tools listed there
- **An enforcement hook runs after every file edit.** If you have not claimed a task, it will block you and tell you to stop. Follow the MCP workflow to avoid interruptions.
`;

const AGENTS_MD = `# Agent Instructions

## Engine Modes

The system supports three engine modes, set at init time or dynamically via MCP:

| Mode | Description |
|------|-------------|
| \`both\` (default) | Cursor = Primary role, Claude Code = Secondary role |
| \`cursor-only\` | Cursor handles both Primary and Secondary roles |
| \`claude-code-only\` | Claude Code handles both Primary and Secondary roles |

In single-engine mode, the active agent gets **all tools** and **merged instructions** from both roles. Self-review is used instead of cross-agent handoffs.

## Roles

Roles are defined by the active **collaboration strategy** using abstract names: **Primary** and **Secondary**. The engine mode maps physical engines to these abstract roles.

In \`both\` mode:
- **Cursor** → Primary role
- **Claude Code** → Secondary role

In single-engine mode, the one active engine fills both roles.

## Task Status State Machine

\`\`\`
assigned ──► in-progress ──► review ──► done
                 ▲               │
                 │               ▼
                 └─── changes-requested
\`\`\`

State transitions are **enforced by the MCP server**. Invalid transitions are rejected.

## Coordination — MCP Server

All coordination goes through the \`agent-collab\` MCP server (backed by SQLite).
Each agent calls targeted MCP tools. The server returns role-aware instructions.

**First tool call in any session:** \`get_my_status\` — tells you exactly what to do next.

## Collaboration Strategies

The system supports 6 research-backed strategies. Strategies use abstract role names (Primary / Secondary), not engine names.

### Architect–Builder (default) \`architect-builder\`
One agent designs the architecture and reviews. The other implements.
- **Primary:** Builder — claims tasks, implements, submits for review
- **Secondary:** Architect / Reviewer — creates HLD, tasks, reviews

### TDD Red–Green \`tdd-red-green\`
One agent writes failing tests first. The other makes them pass.
- **Primary:** Implementer (Green) — makes tests pass without modifying them
- **Secondary:** Test Author (Red) — writes test specs, reviews coverage

### Writer–Reviewer (Critique Loop) \`writer-reviewer\`
One agent generates code. The other critiques from multiple perspectives.
- **Primary:** Writer / Generator — writes and iterates on feedback
- **Secondary:** Multi-Perspective Critic — security, performance, correctness

### Parallel Specialists \`parallel-specialist\`
Each agent owns a domain. Both create and implement tasks. Cross-review each other.
- **Primary:** Specialist A — owns one domain, cross-reviews the other
- **Secondary:** Specialist B — owns the other domain, cross-reviews

### Planner–Executor \`planner-executor\`
One agent produces exhaustively detailed plans. The other executes mechanically.
- **Primary:** Executor — translates specs to code exactly as written
- **Secondary:** Planner / Specifier — pseudocode, contracts, file-by-file specs

### Sequential Quality Pipeline \`sequential-pipeline\`
One agent implements. The other runs multi-stage quality review.
- **Primary:** Implementer — iterates through quality stages
- **Secondary:** Quality Pipeline Manager — security → performance → tests → architecture

## Configuration

\`\`\`bash
# At runtime via MCP tools
set_strategy("writer-reviewer", confirm=true)
set_engine_mode("cursor-only", confirm=true)
\`\`\`

## Constraint Model: MCP vs Agent Definitions

Role-based constraints operate at two levels:

| Layer | Mechanism | Controls | Enforced by |
|-------|-----------|----------|-------------|
| **MCP Server** | Role-based tool access | Which MCP tools each role can call | MCP server |
| **Agent Definition** | \`allowedTools\` in \`.claude/agents/*.md\` | Which built-in tools the agent can use | Claude Code CLI |

An MCP server cannot restrict an agent's built-in tools. For constrained roles (architect, reviewer), both layers must be configured.

## Dashboard

Run \`scripts/dashboard.sh\` to launch the live task board at http://localhost:4800.
`;

const DASHBOARD_SH = `#!/usr/bin/env bash
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

if [[ ! -f ".agent-collab/collab.db" ]]; then
  echo "Error: .agent-collab/collab.db not found. Setup hasn't been run yet."
  exit 1
fi

exec npx -y agent-collab-mcp -- --dashboard \${ARGS[@]+"\${ARGS[@]}"}
`;

const ORCHESTRATE_SH = `#!/usr/bin/env bash
set -euo pipefail

# ── Agent Collaboration Orchestrator ─────────────────────────────────────────
# Drives the implement → review → fix loop.
# Reads task state from SQLite database.
#
# Usage:
#   scripts/orchestrate.sh [options]
#
# Options:
#   --mode semi|full    Semi-automated (default) or fully-automated
#   --max-rounds N      Max review rounds per task (default: 3)
#   --max-tasks N       Max tasks to process (default: all)
#   --dry-run           Show plan without executing
#   --task T-XXX        Process a specific task only
# ─────────────────────────────────────────────────────────────────────────────

MODE="semi"
MAX_ROUNDS=3
MAX_TASKS=999
DRY_RUN=0
SPECIFIC_TASK=""
DB_PATH=".agent-collab/collab.db"
LOG_DIR="scripts/logs"

RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[0;33m'
BLUE='\\033[0;34m'; CYAN='\\033[0;36m'; BOLD='\\033[1m'; NC='\\033[0m'

log_info()  { echo -e "\${BLUE}[INFO]\${NC} $*"; }
log_ok()    { echo -e "\${GREEN}[OK]\${NC} $*"; }
log_warn()  { echo -e "\${YELLOW}[WARN]\${NC} $*"; }
log_err()   { echo -e "\${RED}[ERR]\${NC} $*"; }
log_step()  { echo -e "\${BOLD}\${CYAN}──▶\${NC} $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)       MODE="$2"; shift 2 ;;
    --max-rounds) MAX_ROUNDS="$2"; shift 2 ;;
    --max-tasks)  MAX_TASKS="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --task)       SPECIFIC_TASK="$2"; shift 2 ;;
    -h|--help)    head -17 "$0" | tail -13; exit 0 ;;
    *) log_err "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ ! -f "$DB_PATH" ]]; then
  log_err "Database not found. Run setup first."; exit 1
fi
if ! command -v sqlite3 &>/dev/null; then
  log_err "sqlite3 not found."; exit 1
fi

mkdir -p "$LOG_DIR"

sql() { sqlite3 -separator '|' "$DB_PATH" "$1"; }
get_task_status() { sql "SELECT status FROM tasks WHERE id = '$1'"; }
get_tasks_by_status() { sql "SELECT id FROM tasks WHERE status = '$1' ORDER BY id"; }

ENGINE_MODE=$(sql "SELECT COALESCE((SELECT value FROM config WHERE key = 'engine_mode'), 'both')" 2>/dev/null || echo "both")

run_review() {
  local task_id="$1"
  local logfile="\${LOG_DIR}/review-\${task_id}-$(date +%s).log"
  local prompt="Call get_my_status from the agent-collab MCP. Then get_task(\\"$task_id\\") and review_task with your verdict."
  if [[ $DRY_RUN -eq 1 ]]; then log_info "[DRY RUN] Would review $task_id"; return 0; fi
  if [[ "$ENGINE_MODE" == "cursor-only" ]]; then
    agent -p --force --workspace . "$prompt" > "$logfile" 2>&1 || true
  else
    claude -p --permission-mode auto "$prompt" > "$logfile" 2>&1 || true
  fi
  get_task_status "$task_id"
}

run_implement() {
  local task_id="$1" status="$2"
  local logfile="\${LOG_DIR}/implement-\${task_id}-$(date +%s).log"
  local prompt="Call get_my_status from agent-collab MCP. claim_task(\\"$task_id\\"), implement, submit_for_review."
  if [[ $DRY_RUN -eq 1 ]]; then log_info "[DRY RUN] Would implement $task_id"; return 0; fi
  if [[ "$ENGINE_MODE" == "claude-code-only" ]]; then
    claude -p --permission-mode auto "$prompt" > "$logfile" 2>&1 || true
  else
    agent -p --force --workspace . "$prompt" > "$logfile" 2>&1 || true
  fi
}

process_task() {
  local task_id="$1" round=0 status
  status=$(get_task_status "$task_id")
  if [[ "$status" == "assigned" || "$status" == "changes-requested" ]]; then
    [[ "$MODE" == "full" ]] && run_implement "$task_id" "$status" || { log_warn "$task_id needs work in IDE."; return 0; }
    status=$(get_task_status "$task_id")
  fi
  while [[ $round -lt $MAX_ROUNDS ]]; do
    status=$(get_task_status "$task_id")
    [[ "$status" == "done" ]] && { log_ok "$task_id done!"; return 0; }
    [[ "$status" != "review" ]] && { log_warn "$task_id: unexpected status $status"; return 1; }
    round=$((round + 1))
    local verdict; verdict=$(run_review "$task_id")
    [[ "$verdict" == "done" ]] && { log_ok "$task_id approved!"; return 0; }
    [[ "$verdict" == "changes-requested" ]] && { [[ "$MODE" == "full" ]] && run_implement "$task_id" "changes-requested" || { log_warn "Fix in IDE."; return 0; }; }
  done
  log_err "$task_id: max rounds reached."
}

echo -e "\${BOLD}Orchestrator\${NC} | Mode: \${CYAN}$MODE\${NC} | Engine: \${CYAN}$ENGINE_MODE\${NC}"
processed=0
if [[ -n "$SPECIFIC_TASK" ]]; then process_task "$SPECIFIC_TASK"
else
  for s in changes-requested review assigned; do
    for tid in $(get_tasks_by_status "$s"); do
      [[ $processed -ge $MAX_TASKS ]] && break 2
      process_task "$tid"; processed=$((processed + 1))
    done
  done
fi
[[ $processed -eq 0 ]] && log_info "No actionable tasks." || log_ok "Processed $processed task(s)."
`;

const PRE_COMMIT_HOOK = `#!/usr/bin/env bash
# Enforces the agent-collab workflow: no commits without a claimed task.
# Installed by setup_project into .githooks/pre-commit.
# Activate with: git config core.hooksPath .githooks

set -euo pipefail

DB=".agent-collab/collab.db"

# Skip if agent-collab is not set up
if [[ ! -f "$DB" ]]; then
  exit 0
fi

# Skip if sqlite3 is not available
if ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

# Check engine mode — only enforce in "both" mode
engine_mode=$(sqlite3 "$DB" "SELECT value FROM config WHERE key = 'engine_mode'" 2>/dev/null || echo "")
if [[ "$engine_mode" != "both" ]]; then
  exit 0
fi

# Check if any task is in-progress
in_progress=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status = 'in-progress'" 2>/dev/null || echo "0")

if [[ "$in_progress" -eq 0 ]]; then
  echo ""
  echo "\\033[0;31m❌ BLOCKED: No task is in-progress.\\033[0m"
  echo ""
  echo "The agent-collab workflow requires a claimed task before committing."
  echo "  1. Call claim_task(task_id) to claim a task"
  echo "  2. Implement the changes"
  echo "  3. Then commit"
  echo ""
  echo "To bypass (emergency only): git commit --no-verify"
  echo ""
  exit 1
fi

exit 0
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Claude Code templates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CLAUDE_SETTINGS = `{
  "permissions": {
    "allow": [
      "mcp__agent-collab__*",
      "Read(*)",
      "Grep(*)",
      "Write(*)",
      "Edit(*)"
    ]
  },
  "mcpServers": {
    "agent-collab": {
      "command": "npx",
      "args": ["-y", "agent-collab-mcp@latest"],
      "env": {
        "AGENT_ROLE": "claude-code",
        "AGENT_ENGINE_MODE": "both"
      }
    }
  }
}
`;

const CLAUDE_SESSION_INIT = `#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null

DB=".agent-collab/collab.db"

if [[ ! -f "$DB" ]]; then
  exit 0
fi

if ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

review_count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status = 'review'")

if [[ "$review_count" -gt 0 ]]; then
  review_ids=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE status = 'review' ORDER BY id" | tr '\\n' ', ' | sed 's/,$//')
  jq -n --arg tasks "$review_ids" '{
    addToSystemPrompt: ("Tasks awaiting review: " + $tasks + ". Call get_my_status from agent-collab MCP, then review each task.")
  }'
fi
`;

const CLAUDE_ON_STOP = `#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null

DB=".agent-collab/collab.db"

if [[ ! -f "$DB" ]] || ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

changes_task=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE status = 'changes-requested' ORDER BY updated_at DESC LIMIT 1" 2>/dev/null || echo "")

if [[ -z "$changes_task" ]]; then
  exit 0
fi

if [[ "\${AGENT_COLLAB_FULL_AUTO:-}" == "1" ]] && command -v agent &>/dev/null; then
  mkdir -p scripts/logs
  agent -p --force --workspace . \\
    "Call get_my_status from agent-collab MCP. Claim task $changes_task, fix the issues, submit for review." \\
    > "scripts/logs/fix-\${changes_task}-$(date +%s).log" 2>&1 || true

  new_status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id = '$changes_task'")
  if [[ "$new_status" == "review" ]]; then
    jq -n --arg task "$changes_task" '{
      followup_message: ("Task " + $task + " resubmitted. Call get_my_status and review again.")
    }'
  fi
fi
`;

const CLAUDE_TASK_REVIEWER = `---
name: task-reviewer
description: "Reviews completed tasks using the agent-collab MCP server."
model: opus
color: blue
allowedTools:
  - "mcp__agent-collab__*"
  - "Read(*)"
  - "Glob(*)"
  - "Grep(*)"
---

You are an elite code and task reviewer.

## Core Responsibilities

1. **Call \`get_my_status\`** from the agent-collab MCP to see what needs review.
2. **Review each task** — examine changed/created files for correctness, quality, edge cases, consistency.
3. **Submit your review** via \`review_task\` MCP tool.

## Review Process

1. \`get_my_status\` — see tasks awaiting review
2. \`get_task(id)\` — read context, acceptance criteria, and plan
3. Read all files changed or created for the task
4. \`review_task(id, verdict, issues, notes)\` — submit the review

## Verdict Rules

- **approved**: All acceptance criteria met, no critical issues.
- **changes-requested**: Any critical issue or missing acceptance criteria.

## Severity Guide

- **critical**: Bugs, security issues, broken functionality
- **warning**: Code smell, missing error handling
- **note**: Style preferences, potential optimizations
`;

const CLAUDE_ARCHITECT = `---
name: architect
description: "Designs architecture and creates tasks via the agent-collab MCP server. MCP-only — does not write files or run commands."
model: opus
color: green
allowedTools:
  - "mcp__agent-collab__*"
  - "Read(*)"
  - "Glob(*)"
  - "Grep(*)"
---

You are the Architect agent. You design high-level architecture and break work into tasks.

## Constraints

You MUST only use MCP tools from the agent-collab server. You must NOT:
- Write, create, or edit any files
- Run shell commands or scripts
- Use the Write, Edit, or Bash tools
- Create scripts or code files of any kind

Your ONLY output is through MCP tool calls: \\\`set_context\\\`, \\\`create_task\\\`, \\\`log_activity\\\`.

## Workflow

1. **Call \\\`get_my_status\\\`** from the agent-collab MCP to confirm your role.
2. **Read the codebase** with Read, Glob, Grep to understand the existing structure.
3. **Create an HLD** via \\\`set_context("hld", ...)\\\` — describe the architecture, key decisions, and component boundaries.
4. **Break the work into tasks** via \\\`create_task(...)\\\` — each task should have:
   - A clear title
   - 2-3 lines of context from the HLD
   - Specific acceptance criteria
   - Dependencies on other tasks (\\\`depends_on\\\`) where applicable
   - Priority (higher = more important)
5. **Set \\\`notify_builder=true\\\`** on the LAST \\\`create_task\\\` call to auto-invoke the builder.

## Task Design Guidelines

- Tasks should be small enough for one focused implementation session (30-60 min).
- Order tasks by dependency graph, not importance.
- Each task's acceptance criteria should be objectively verifiable.
- Use \\\`depends_on\\\` to encode the dependency DAG.
- Set higher \\\`priority\\\` for foundational/blocking tasks.
`;

const CLAUDE_MD = `# Agent Collaboration Protocol (Claude Code)

You are part of a coordinated agent system. Call \`get_my_status\` from the agent-collab MCP to see your current role and next action.

In single-engine mode (\`claude-code-only\`), you handle **both** Primary and Secondary roles.

## On Every Session Start

Call \`get_my_status\` from the agent-collab MCP. Follow its instructions exactly.

## Your MCP Tools

- \`get_my_status\` — see what to do next (ALWAYS call first)
- \`get_active_strategy\` — see current strategy, engine mode, and your role
- \`list_strategies\` / \`set_strategy\` — view or change collaboration strategy
- \`set_engine_mode\` — switch engine modes
- \`create_task\` / \`claim_task\` / \`submit_for_review\` / \`review_task\`
- \`set_context\` / \`get_context\` — manage PRD and HLD documents
- \`get_task\` / \`get_review_feedback\` / \`get_project_overview\` / \`log_activity\`

## Review Standards

- Be specific: reference exact file paths and line numbers
- Be actionable: suggest fixes, not just problems
- Be fair: acknowledge what was done well
- Severity: **critical** (blocks), **warning** (should fix), **note** (advisory)
`;
