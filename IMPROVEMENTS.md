# Agent-Collab MCP: Improvement Suggestions

The agent-collab MCP is a ~3,500 LOC multi-agent coordination framework (Node.js/TypeScript + SQLite) that enables structured collaboration between Cursor and Claude Code via 6 research-backed strategies. The following improvements address gaps in reliability, observability, developer experience, and scalability, organized by impact/effort ratio.

---

## High Impact / Low Effort (Quick Wins)

### 1. Validate AGENT_ROLE environment variable

- **Problem:** Typos like `AGENT_ROLE=cladue-code` silently default to `"unknown"`, causing confusing merged-role behavior
- **Fix:** In `src/db.ts` `getRole()`, validate against `["cursor", "claude-code"]` and log a prominent warning to stderr if unrecognized
- **File:** `agent-collab-mcp/src/db.ts`
- **Effort:** ~15 min

### 2. Activity log retention policy

- **Problem:** `activity_log` table grows unbounded, slowing dashboard queries over time
- **Fix:** Add `pruneActivityLog()` in `migrate()` that keeps only the most recent 500 entries (configurable via `config` table key `activity_log_max_rows`)
- **File:** `agent-collab-mcp/src/db.ts`
- **Effort:** ~30 min

### 3. Enforce task dependency blocking

- **Problem:** `depends_on` is stored but never checked — agents can claim tasks whose dependencies aren't done
- **Fix:** In `claim_task` handler, query dependency statuses and block if any aren't `done`. Show dependency status in `get_task` and dashboard
- **File:** `agent-collab-mcp/src/tools/tasks.ts`
- **Effort:** ~30 min

### 4. Task priority field

- **Problem:** All tasks are equal; `get_my_status` picks by ID order, not importance
- **Fix:** Add `priority INTEGER DEFAULT 0` column. Sort by `priority DESC` in status queries. Add optional `priority` param to `create_task`
- **Files:** `src/db.ts`, `src/tools/tasks.ts`, `src/tools/status.ts`
- **Effort:** ~45 min

### 5. Deduplicate TypeScript interfaces

- **Problem:** `TaskRow`, `ReviewRow` etc. defined in 4-5 files with slightly different shapes — maintenance hazard
- **Fix:** Create `src/types.ts` with canonical interfaces, import everywhere
- **Files:** New `src/types.ts`, all `src/tools/*.ts`
- **Effort:** ~30 min

### 6. Consistent structured error handling

- **Problem:** Ad-hoc error strings make it hard for agents to distinguish error types programmatically
- **Fix:** Create `error(code, message)` helper with codes like `NOT_FOUND`, `INVALID_STATE`, `DEPENDENCY_BLOCKED`. Replace ad-hoc returns across all tool files
- **Files:** New `src/errors.ts`, all `src/tools/*.ts`
- **Effort:** ~1-2 hours

### 7. Centralize JSON issues parsing

- **Problem:** Review `issues` JSON parsing duplicated in 5 places with identical try/catch fallback
- **Fix:** Create `parseIssues(text)` utility, replace all 5 duplicate blocks
- **Files:** New utility in `src/utils.ts`, `src/tools/tasks.ts`, `src/tools/reviews.ts`, `src/tools/epic.ts`
- **Effort:** ~30 min

---

## High Impact / High Effort (Strategic Investments)

### 8. Comprehensive test suite

- **Problem:** Zero tests in a 3,500 LOC coordination system — any regression in the state machine or role mapping causes silent failures
- **Fix:** Add `vitest`, create tests for:
  - `db.test.ts` — role resolution, ID generation, auto-setup
  - `strategies.test.ts` — role config merging, tool access matrices
  - `tasks.test.ts` — state machine transitions, dependency enforcement
  - `reviews.test.ts` — round counting, verdict processing
  - `dispatch.test.ts` — mock spawn, CLI existence checks
  - Use in-memory SQLite (`:memory:`) for test isolation
- **Files:** New `src/__tests__/` directory, `package.json` (add vitest)
- **Effort:** ~8-12 hours

### 9. File reservation system for parallel specialists

- **Problem:** Parallel agents can modify the same files, causing conflicts. Research basis mentions file reservation but it's not implemented
- **Fix:** Add `file_reservations` table (path, task_id). New `reserve_files` and `check_conflicts` MCP tools. Auto-release on task completion. Warn on `claim_task` if files overlap
- **Files:** `src/db.ts`, new `src/tools/reservations.ts`, `src/tools/tasks.ts`
- **Effort:** ~4-6 hours

### 10. Real-time dashboard via SSE

- **Problem:** 3-second polling = 6 HTTP requests/cycle, wasteful and laggy
- **Fix:** Add `/api/events` SSE endpoint that pushes state changes. Replace `setInterval(refresh, 3000)` with `EventSource`. Keep REST endpoints for initial load
- **File:** `agent-collab-mcp/src/dashboard.ts`
- **Effort:** ~3-4 hours

### 11. Interactive dashboard (read-write)

- **Problem:** Dashboard is read-only; users must switch to terminal/agent to take actions
- **Fix:** Add POST endpoints (`/api/task/claim`, `/api/task/trigger-review`, `/api/epic/archive`, `/api/strategy/set`). Open DB read-write for POSTs. Add action buttons with confirmation dialogs. Add basic CSRF protection
- **File:** `agent-collab-mcp/src/dashboard.ts`
- **Effort:** ~6-8 hours

### 12. Metrics and analytics

- **Problem:** No way to measure collaboration effectiveness or compare strategies
- **Fix:** Add `task_transitions` table to log status changes with timestamps. Compute: avg task duration, review rounds, first-pass approval rate, time per status. New `get_metrics` tool + `/api/metrics` endpoint + dashboard panel
- **Files:** `src/db.ts`, new `src/tools/metrics.ts`, `src/dashboard.ts`
- **Effort:** ~6-8 hours

### 13. Task commenting/discussion

- **Problem:** No way for agents to communicate about a task beyond formal review verdicts
- **Fix:** Add `task_comments` table. New `add_comment(task_id, message)` and `get_comments(task_id)` tools. Show in `get_task` output and dashboard modal
- **Files:** `src/db.ts`, new `src/tools/comments.ts`, `src/dashboard.ts`
- **Effort:** ~3-4 hours

---

## Medium Impact (Nice-to-Haves)

### 14. Dispatch retry and health monitoring

- **Problem:** Failed dispatches have no retry; spawned processes can crash or hang undetected
- **Fix:** Add `dispatches` table tracking PIDs and status. Retry with backoff (2 attempts, 5s/15s). Add `check_dispatch_health` that detects stale processes. Show dispatch status in dashboard
- **Files:** `src/db.ts`, `src/dispatch.ts`, `src/tools/dispatch.ts`, `src/dashboard.ts`
- **Effort:** ~3-4 hours

### 15. Epic restoration (undo archive)

- **Problem:** Epic archival is one-way; premature archival requires manual re-creation
- **Fix:** Add `restore_epic(epic_id)` tool that re-hydrates tasks from `epic_tasks` back to `tasks`, restores context docs, handles ID conflicts. Add "Restore" button in dashboard
- **Files:** `src/tools/epic.ts`, `src/dashboard.ts`
- **Effort:** ~2-3 hours

### 16. Hot-reload strategy switching

- **Problem:** `set_strategy` requires MCP restart because role config is computed once at startup
- **Fix:** Remove static `instructions` from McpServer constructor. Compute role config dynamically in each tool handler (most already do via `getToolAccess()`). Add strategy-change detection in `get_my_status`
- **File:** `agent-collab-mcp/src/index.ts`
- **Effort:** ~1-2 hours

### 17. Git branch integration

- **Problem:** No version control integration; multi-agent edits on same branch cause conflicts
- **Fix:** Add `task_branch` column. On `claim_task`, optionally create `task/<task-id>` branch (behind `git_integration` config flag). On review approval, suggest merge. Show git status in dashboard
- **Files:** `src/db.ts`, `src/tools/tasks.ts`, `src/tools/reviews.ts`
- **Effort:** ~4-6 hours

### 18. Notification webhooks

- **Problem:** No notification system beyond CLI dispatch
- **Fix:** Add `webhooks` config (JSON array of `{url, events}`). Fire async POST on state transitions. Add `configure_webhooks` tool
- **Files:** `src/tools/tasks.ts`, `src/tools/reviews.ts`, new `src/webhooks.ts`
- **Effort:** ~2-3 hours

### 19. Dashboard authentication

- **Problem:** Dashboard on port 4800 is completely open; risky in remote/codespace environments
- **Fix:** Support `DASHBOARD_AUTH_TOKEN` env var. Check Bearer token on API requests. Add login form for HTML UI. Skip auth if no token configured (backward compatible)
- **File:** `agent-collab-mcp/src/dashboard.ts`
- **Effort:** ~1-2 hours

### 20. Task cancellation/archival

- **Problem:** No way to cancel or remove a task without archiving the entire epic
- **Fix:** Add `cancelled` status to state machine. Add `cancel_task(task_id, reason)` tool. Cancelled tasks hidden from active board but preserved for audit
- **Files:** `src/tools/tasks.ts`, `src/tools/status.ts`, `src/dashboard.ts`
- **Effort:** ~1 hour

---

## Implementation Priority (Recommended Order)

**Phase 1 — Foundation (items 1, 2, 3, 5, 6, 7):** Fix silent bugs, enforce existing data, clean up code. All low-effort, immediately valuable.

**Phase 2 — Reliability (items 8, 4, 14, 20):** Add tests, priority ordering, dispatch monitoring, task cancellation. Makes the system trustworthy.

**Phase 3 — Collaboration (items 9, 13, 16):** File reservations, commenting, hot-reload. Unlocks better multi-agent workflows.

**Phase 4 — Observability (items 10, 12, 11):** Real-time dashboard, metrics, interactive actions. Makes the system observable and controllable.

**Phase 5 — Integration (items 15, 17, 18, 19):** Epic restore, git branches, webhooks, auth. Polish for production use.
