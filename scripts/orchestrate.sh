#!/usr/bin/env bash
set -euo pipefail

# ── Agent Collaboration Orchestrator ─────────────────────────────────────────
# Drives the implement → review → fix loop between Cursor and Claude Code.
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
MANIFEST=".shared-memory/MANIFEST.md"
LOG_DIR="scripts/logs"
STATUS_FILE="scripts/.status"
POLL_INTERVAL=5

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
if [[ ! -f "$MANIFEST" ]]; then
  log_err "MANIFEST.md not found at $MANIFEST"
  log_err "Run init.sh first or check your working directory."
  exit 1
fi

mkdir -p "$LOG_DIR"

if ! command -v claude &>/dev/null; then
  log_warn "claude CLI not found on PATH. Reviews will fail."
fi

if [[ "$MODE" == "full" ]] && ! command -v agent &>/dev/null; then
  log_warn "agent CLI not found on PATH. Full-auto implementation will fail."
fi

# ── Helper: get task status from MANIFEST ────────────────────────────────────
get_task_status() {
  local task_id="$1"
  grep "$task_id" "$MANIFEST" | head -1 | awk -F'|' '{print $4}' | xargs
}

# ── Helper: get task changelog path from MANIFEST ────────────────────────────
get_task_changelog() {
  local task_id="$1"
  grep "$task_id" "$MANIFEST" | head -1 | awk -F'|' '{print $6}' | xargs
}

# ── Helper: collect tasks matching a status ──────────────────────────────────
get_tasks_by_status() {
  local target_status="$1"
  local tasks=()
  while IFS='|' read -r _ id _ status _ _ _; do
    id=$(echo "$id" | xargs)
    status=$(echo "$status" | xargs)
    if [[ "$status" == "$target_status" ]]; then
      tasks+=("$id")
    fi
  done < <(grep '^|' "$MANIFEST" | tail -n +3)
  echo "${tasks[@]:-}"
}

# ── Helper: wait for a task to reach a target status ─────────────────────────
wait_for_status() {
  local task_id="$1"
  local target="$2"
  local timeout="${3:-300}"
  local elapsed=0

  while [[ $elapsed -lt $timeout ]]; do
    local current
    current=$(get_task_status "$task_id")
    if [[ "$current" == "$target" || "$current" == "done" || "$current" == "changes-requested" ]]; then
      echo "$current"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "timeout"
  return 1
}

# ── Run Claude Code review ───────────────────────────────────────────────────
run_review() {
  local task_id="$1"
  local changelog
  changelog=$(get_task_changelog "$task_id")
  local logfile="${LOG_DIR}/review-${task_id}-$(date +%s).log"

  log_step "Reviewing $task_id via claude -p"

  if [[ $DRY_RUN -eq 1 ]]; then
    log_info "[DRY RUN] Would invoke: claude -p --permission-mode auto \"Review task $task_id ...\""
    return 0
  fi

  claude -p --permission-mode auto \
    "Review task $task_id per the reviewer workflow in CLAUDE.md. Read .shared-memory/$changelog for context and acceptance criteria. Write the review to the changelog's ## Review section and update MANIFEST status." \
    > "$logfile" 2>&1 || true

  local new_status
  new_status=$(get_task_status "$task_id")
  log_info "Review complete. Status: $new_status (log: $logfile)"
  echo "$new_status"
}

# ── Run Cursor implementation (full mode only) ───────────────────────────────
run_implement() {
  local task_id="$1"
  local status="$2"
  local changelog
  changelog=$(get_task_changelog "$task_id")
  local logfile="${LOG_DIR}/implement-${task_id}-$(date +%s).log"

  if [[ "$status" == "changes-requested" ]]; then
    log_step "Fixing $task_id via agent -p --force"
    local prompt="Task $task_id has changes-requested. Read .shared-memory/$changelog — address every issue in the ## Review section per the shared-memory protocol in .cursor/rules/shared-memory.mdc, then set status to review."
  else
    log_step "Implementing $task_id via agent -p --force"
    local prompt="Implement task $task_id. Read .shared-memory/$changelog for context and acceptance criteria. Follow the shared-memory protocol in .cursor/rules/shared-memory.mdc."
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    log_info "[DRY RUN] Would invoke: agent -p --force --workspace . \"$prompt\""
    return 0
  fi

  agent -p --force --workspace . "$prompt" > "$logfile" 2>&1 || true

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

  # If assigned or changes-requested, implementation is needed first
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

  # Review loop
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
        log_warn "Review feedback written to changelog. Fix in Cursor IDE and re-run."
        echo -e "  ${CYAN}Cursor IDE:${NC} say 'continue' — the sessionStart hook will pick up the review."
        echo ""
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
echo -e "${BOLD}Agent Collaboration Orchestrator${NC}"
echo -e "Mode: ${CYAN}$MODE${NC} | Max rounds: $MAX_ROUNDS | Max tasks: $MAX_TASKS"
if [[ $DRY_RUN -eq 1 ]]; then
  echo -e "${YELLOW}DRY RUN — no agents will be invoked${NC}"
fi
echo ""

task_count=0

if [[ -n "$SPECIFIC_TASK" ]]; then
  process_task "$SPECIFIC_TASK"
else
  # Process changes-requested tasks first (they're mid-review-loop)
  for task_id in $(get_tasks_by_status "changes-requested"); do
    if [[ $task_count -ge $MAX_TASKS ]]; then break; fi
    process_task "$task_id"
    task_count=$((task_count + 1))
  done

  # Then review tasks
  for task_id in $(get_tasks_by_status "review"); do
    if [[ $task_count -ge $MAX_TASKS ]]; then break; fi
    process_task "$task_id"
    task_count=$((task_count + 1))
  done

  # Then assigned tasks
  for task_id in $(get_tasks_by_status "assigned"); do
    if [[ $task_count -ge $MAX_TASKS ]]; then break; fi
    process_task "$task_id"
    task_count=$((task_count + 1))
  done
fi

echo ""
if [[ $task_count -eq 0 ]]; then
  log_info "No actionable tasks found in MANIFEST."
else
  log_ok "Processed $task_count task(s)."
fi
