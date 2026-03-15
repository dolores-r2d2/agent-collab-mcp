#!/usr/bin/env bash
set -euo pipefail

# ── Agent Collaboration Orchestrator (MCP/SQLite) ────────────────────────────
# Drives the implement → review → fix loop between Cursor and Claude Code.
# Reads task state from the SQLite database via the agent-collab-mcp server.
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
#   -h, --help          Show this help
# ─────────────────────────────────────────────────────────────────────────────

MODE="semi"
MAX_ROUNDS=3
MAX_TASKS=999
DRY_RUN=0
SPECIFIC_TASK=""
DB_PATH=".agent-collab/collab.db"
LOG_DIR="scripts/logs"

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_err()   { echo -e "${RED}[ERR]${NC} $*"; }
log_step()  { echo -e "${BOLD}${CYAN}──▶${NC} $*"; }

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)       MODE="$2"; shift 2 ;;
    --max-rounds) MAX_ROUNDS="$2"; shift 2 ;;
    --max-tasks)  MAX_TASKS="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --task)       SPECIFIC_TASK="$2"; shift 2 ;;
    -h|--help)
      head -17 "$0" | tail -15
      exit 0
      ;;
    *) log_err "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$MODE" != "semi" && "$MODE" != "full" ]]; then
  log_err "Invalid mode: $MODE (must be 'semi' or 'full')"
  exit 1
fi

# ── Pre-flight checks ───────────────────────────────────────────────────────
if [[ ! -f "$DB_PATH" ]]; then
  log_err "Database not found at $DB_PATH"
  log_err "Run init.sh first or ensure the MCP server has been started at least once."
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  log_err "sqlite3 CLI not found. Install it to use the orchestrator."
  exit 1
fi

mkdir -p "$LOG_DIR"

ENGINE_MODE=$(sql "SELECT COALESCE((SELECT value FROM config WHERE key = 'engine_mode'), 'both')" 2>/dev/null || echo "both")

if [[ "$ENGINE_MODE" == "both" ]] || [[ "$ENGINE_MODE" == "claude-code-only" ]]; then
  if ! command -v claude &>/dev/null; then
    log_warn "claude CLI not found on PATH. Reviews will fail."
  fi
fi

if [[ "$MODE" == "full" ]]; then
  if [[ "$ENGINE_MODE" == "both" ]] || [[ "$ENGINE_MODE" == "cursor-only" ]]; then
    if ! command -v agent &>/dev/null; then
      log_warn "agent CLI not found on PATH. Full-auto implementation will fail."
    fi
  fi
fi

# ── Helper: query SQLite ─────────────────────────────────────────────────────
sql() {
  sqlite3 -separator '|' "$DB_PATH" "$1"
}

# ── Helper: get task status ──────────────────────────────────────────────────
get_task_status() {
  sql "SELECT status FROM tasks WHERE id = '$1'"
}

# ── Helper: get tasks by status ──────────────────────────────────────────────
get_tasks_by_status() {
  sql "SELECT id FROM tasks WHERE status = '$1' ORDER BY id"
}

# ── Run review (delegates to the right engine) ──────────────────────────────
run_review() {
  local task_id="$1"
  local logfile="${LOG_DIR}/review-${task_id}-$(date +%s).log"
  local prompt="Call get_my_status from the agent-collab MCP server. Then call get_task(\"$task_id\") to read the task details. Review the implementation files, then call review_task with your verdict."

  if [[ $DRY_RUN -eq 1 ]]; then
    log_info "[DRY RUN] Would review $task_id"
    return 0
  fi

  if [[ "$ENGINE_MODE" == "cursor-only" ]]; then
    log_step "Reviewing $task_id via agent -p --force (single-engine mode)"
    agent -p --force --workspace . "$prompt" > "$logfile" 2>&1 || true
  else
    log_step "Reviewing $task_id via claude -p"
    claude -p --permission-mode auto "$prompt" > "$logfile" 2>&1 || true
  fi

  local new_status
  new_status=$(get_task_status "$task_id")
  log_info "Review complete. Status: $new_status (log: $logfile)"
  echo "$new_status"
}

# ── Run implementation (delegates to the right engine) ───────────────────────
run_implement() {
  local task_id="$1"
  local status="$2"
  local logfile="${LOG_DIR}/implement-${task_id}-$(date +%s).log"

  if [[ "$status" == "changes-requested" ]]; then
    local prompt="Call get_my_status from the agent-collab MCP. Then claim_task(\"$task_id\") and get_review_feedback(\"$task_id\") to see issues. Fix them all, then submit_for_review."
  else
    local prompt="Call get_my_status from the agent-collab MCP. Then claim_task(\"$task_id\") to start working. Read the task with get_task, save a plan with save_plan, implement, then submit_for_review."
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    log_info "[DRY RUN] Would implement $task_id"
    return 0
  fi

  if [[ "$ENGINE_MODE" == "claude-code-only" ]]; then
    log_step "${status == 'changes-requested' ? 'Fixing' : 'Implementing'} $task_id via claude -p"
    claude -p --permission-mode auto "$prompt" > "$logfile" 2>&1 || true
  else
    log_step "$([ "$status" == 'changes-requested' ] && echo 'Fixing' || echo 'Implementing') $task_id via agent -p --force"
    agent -p --force --workspace . "$prompt" > "$logfile" 2>&1 || true
  fi

  local new_status
  new_status=$(get_task_status "$task_id")
  log_info "Implementation complete. Status: $new_status (log: $logfile)"
}

# ── Process a single task through the review loop ────────────────────────────
process_task() {
  local task_id="$1"
  local round=0

  log_step "${BOLD}Processing $task_id${NC}"

  local status
  status=$(get_task_status "$task_id")

  if [[ "$status" == "assigned" || "$status" == "changes-requested" ]]; then
    if [[ "$MODE" == "full" ]]; then
      run_implement "$task_id" "$status"
      status=$(get_task_status "$task_id")
    else
      if [[ "$status" == "assigned" ]]; then
        log_warn "$task_id is assigned. Implement it in Cursor IDE, then re-run."
        return 0
      else
        log_warn "$task_id needs fixes. Open Cursor IDE and say 'continue', then re-run."
        return 0
      fi
    fi
  fi

  while [[ $round -lt $MAX_ROUNDS ]]; do
    status=$(get_task_status "$task_id")

    if [[ "$status" == "done" ]]; then
      log_ok "$task_id passed review!"
      return 0
    fi

    if [[ "$status" != "review" ]]; then
      log_warn "$task_id is in unexpected status: $status"
      return 1
    fi

    round=$((round + 1))
    log_info "Review round $round/$MAX_ROUNDS for $task_id"

    local verdict
    verdict=$(run_review "$task_id")

    if [[ "$verdict" == "done" ]]; then
      log_ok "$task_id approved on round $round!"
      return 0
    elif [[ "$verdict" == "changes-requested" ]]; then
      log_warn "$task_id needs fixes (round $round)"

      if [[ "$MODE" == "full" ]]; then
        run_implement "$task_id" "changes-requested"
      else
        echo ""
        log_warn "Review feedback written. Fix in Cursor IDE and re-run."
        return 0
      fi
    else
      log_err "Unexpected review verdict: $verdict"
      return 1
    fi
  done

  log_err "$task_id: max review rounds ($MAX_ROUNDS) reached. Manual intervention needed."
  return 1
}

# ── Main ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Agent Collaboration Orchestrator (MCP)${NC}"
echo -e "Mode: ${CYAN}$MODE${NC} | Engine: ${CYAN}$ENGINE_MODE${NC} | Max rounds: $MAX_ROUNDS | Max tasks: $MAX_TASKS"
if [[ $DRY_RUN -eq 1 ]]; then
  echo -e "${YELLOW}DRY RUN — no agents will be invoked${NC}"
fi

task_count=$(sql "SELECT COUNT(*) FROM tasks")
echo -e "Database: ${CYAN}$DB_PATH${NC} ($task_count tasks)"
echo ""

processed=0

if [[ -n "$SPECIFIC_TASK" ]]; then
  process_task "$SPECIFIC_TASK"
else
  for task_id in $(get_tasks_by_status "changes-requested"); do
    if [[ $processed -ge $MAX_TASKS ]]; then break; fi
    process_task "$task_id"
    processed=$((processed + 1))
  done

  for task_id in $(get_tasks_by_status "review"); do
    if [[ $processed -ge $MAX_TASKS ]]; then break; fi
    process_task "$task_id"
    processed=$((processed + 1))
  done

  for task_id in $(get_tasks_by_status "assigned"); do
    if [[ $processed -ge $MAX_TASKS ]]; then break; fi
    process_task "$task_id"
    processed=$((processed + 1))
  done
fi

echo ""
if [[ $processed -eq 0 ]]; then
  log_info "No actionable tasks found."
else
  log_ok "Processed $processed task(s)."
fi
