# Agent-Collab MCP: Improvements — Post AI-DAW Field Report

Findings from an AI-DAW session where the architect agent was dispatched via `claude -p --permission-mode auto` with a loose prompt. Instead of calling MCP tools, it wrote a Node.js script (`scripts/architect-setup.js`) that bypasses the MCP entirely, then stalled ~50 minutes waiting for shell approval that never came. The builder eventually switched to `cursor-only` and did everything itself — no cross-agent review cycle ever ran.

**Root cause:** The MCP controls its own tool access per role, but has **zero control** over a spawned agent's built-in tools (Read, Write, Edit, Bash). `.claude/settings.json` grants `Write(*)` and `Edit(*)` to all Claude Code sessions, so the dispatched architect was free to ignore MCP tools and write scripts instead.

---

## Section 1: Critical — Architect Dispatch (the 50-minute failure)

### 1. Create a dedicated `architect` agent definition

- **Problem:** `dispatchArchitect()` uses `claude -p` with an inline prompt. The agent has full tool access and no structural constraint forcing it to use MCP tools.
- **Fix:** Create `template/.claude/agents/architect.md` (modeled on the existing `task-reviewer.md`). The agent definition should:
  - Explicitly restrict: "You MUST only use MCP tools. Do NOT write files, scripts, or shell commands. Do NOT use Write, Edit, or Bash tools."
  - Use `allowedTools` in frontmatter to whitelist only `mcp__agent-collab__*`, `Read`, `Glob`, `Grep`
  - Change `dispatchArchitect()` in `agent-collab-mcp/src/dispatch.ts` to use `claude agent architect` instead of `claude -p`
- **Why this works:** Agent definitions are Claude Code's mechanism for constraining tool access at the agent level — the one thing an MCP server cannot do.
- **File:** New `template/.claude/agents/architect.md`, modify `agent-collab-mcp/src/dispatch.ts`

### 2. Restrict permissions for dispatched processes

- **Problem:** `.claude/settings.json` grants `Write(*)`, `Edit(*)` to ALL Claude Code sessions, including dispatched agents that should be MCP-only.
- **Fix:** Use `allowedTools` in the agent definition frontmatter to scope permissions per role. The architect agent only needs: `mcp__agent-collab__*`, `Read(*)`, `Glob(*)`, `Grep(*)`. The reviewer agent (already defined) should similarly have `allowedTools` added.
- **File:** `template/.claude/agents/architect.md`, `template/.claude/agents/task-reviewer.md`

### 3. Harden the dispatch prompt

- **Problem:** Current architect prompt in `dispatchArchitect()` (line 148 of `dispatch.ts`) is purely positive: "Call get_my_status... Create an HLD... break into tasks..." — it never tells the agent what NOT to do.
- **Fix:** Add explicit negative constraints to the prompt: "Do NOT write files. Do NOT use Bash. Do NOT create scripts. Use ONLY MCP tools for all actions." Even with agent definitions, belt-and-suspenders prompting reduces drift.
- **File:** `agent-collab-mcp/src/dispatch.ts` (lines 148, 117-118)

### 4. Watchdog timeout on dispatch

- **Problem:** `dispatchArchitect()` spawns a detached process and returns immediately. If the agent stalls (as happened for 50 minutes), nothing detects or kills it.
- **Fix:** After spawning the architect, poll the DB every 30s for new tasks. If no tasks are created within a configurable timeout (default 5 min), kill the PID, log the failure, and return an error. Add `dispatch_timeout_seconds` config key.
- **File:** `agent-collab-mcp/src/dispatch.ts`

### 5. Use `--permission-mode bypassPermissions` for constrained dispatches

- **Problem:** `--permission-mode auto` still blocks arbitrary shell commands — which is exactly what happened when the architect tried to run its self-written script.
- **Fix:** If the agent is constrained to MCP-only via agent definition + `allowedTools`, `bypassPermissions` is safe and avoids the approval-gate deadlock. Alternative: keep `auto` but ensure the agent definition prevents shell commands.
- **File:** `agent-collab-mcp/src/dispatch.ts` (line 155)

---

## Section 2: Cross-Agent Review Activation

### 6. Auto-trigger review dispatch on `submit_for_review`

- **Problem:** `submit_for_review` changes task status but doesn't dispatch a reviewer. Someone must manually call `trigger_review` or run `orchestrate.sh`. In the AI-DAW session, no review cycle ever ran.
- **Fix:** Add `auto_dispatch_review` config flag (default `true` in `both` mode). When enabled, `submit_for_review` automatically calls `dispatchReview([taskId])` internally.
- **File:** `agent-collab-mcp/src/tools/tasks.ts`

### 7. Use the `task-reviewer` agent definition for reviews

- **Problem:** `template/.claude/agents/task-reviewer.md` exists with proper review instructions, but `dispatchAgent("reviewer", ...)` in `dispatch.ts` uses `claude -p` with an inline prompt (line 58), ignoring the agent definition entirely.
- **Fix:** Change the reviewer dispatch path to use `claude agent task-reviewer` instead of `claude -p`. The agent definition already has the right instructions and constraints.
- **File:** `agent-collab-mcp/src/dispatch.ts` (lines 57-58)

---

## Section 3: Observability

### 8. Dispatch health monitoring

- **Problem:** Dispatched processes can crash, hang, or stall undetected. No tracking beyond an activity log entry.
- **Fix:** Add a `dispatches` table (`id`, `pid`, `target`, `status`, `started_at`, `completed_at`). Track all dispatches. `get_my_status` shows active dispatches. Dashboard shows dispatch status with elapsed time. Detect stale processes (no DB activity + PID dead).
- **Files:** `agent-collab-mcp/src/db.ts`, `agent-collab-mcp/src/dispatch.ts`, `agent-collab-mcp/src/dashboard.ts`

### 9. Structured activity log to file

- **Problem:** Activity is logged to SQLite only — not parseable by external tools, CI systems, or post-mortem scripts.
- **Fix:** Emit structured log lines to `scripts/logs/activity.log` on every MCP state change. Format: `<timestamp>\t<action>\t<key=value pairs>`. Complements the DB log for offline analysis.
- **File:** `agent-collab-mcp/src/db.ts` or new `agent-collab-mcp/src/logger.ts`

---

## Section 4: Beyond MCP — What an MCP Cannot Solve

### 10. The MCP-only limitation (architectural note)

An MCP server controls access to **its own tools**. It **cannot** restrict an agent's built-in tools (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`). For role-based constraints to work, you need a mechanism at the **agent level**, not the server level:

- **Claude Code's mechanism:** Agent definitions (`.claude/agents/*.md`) with `allowedTools` in frontmatter — these are enforced by the CLI.
- **Cursor's mechanism:** Rules files (`.cursor/rules/*.mdc`) with behavioral constraints — advisory, not enforced.

**Recommendation:** For every MCP role that should be constrained (architect, reviewer), create a corresponding agent definition with explicit `allowedTools`. The MCP role determines *what MCP tools are available*; the agent definition determines *what non-MCP tools are available*.

### 11. Consider a Claude Code skill for `invoke_architect`

- Instead of spawning a subprocess, a skill (`.claude/skills/`) could run the architect workflow in-process.
- **Pros:** No subprocess management, no permission issues, inherits current session's MCP connection.
- **Cons:** Blocks the calling agent's session, can't run in parallel.
- **Verdict:** Agent definitions are better for async dispatch; skills are better for synchronous single-agent workflows. Worth exploring for `claude-code-only` mode.

---

## Section 5: Retained from Original (still valid)

### 12. Validate AGENT_ROLE environment variable

- **Problem:** Typos like `AGENT_ROLE=cladue-code` silently default to `"unknown"`, causing confusing merged-role behavior.
- **Fix:** In `src/db.ts` `getRole()`, validate against `["cursor", "claude-code"]` and log a prominent warning to stderr if unrecognized.
- **File:** `agent-collab-mcp/src/db.ts`

### 13. Activity log retention policy

- **Problem:** `activity_log` table grows unbounded, slowing dashboard queries over time.
- **Fix:** Add `pruneActivityLog()` in `migrate()` that keeps only the most recent 500 entries (configurable via `config` table key `activity_log_max_rows`).
- **File:** `agent-collab-mcp/src/db.ts`

### 14. Enforce task dependency blocking

- **Problem:** `depends_on` is stored but never checked — agents can claim tasks whose dependencies aren't done. Confirmed as a real issue in AI-DAW report section 3.1.
- **Fix:** In `claim_task` handler, query dependency statuses and block if any aren't `done`. Show dependency status in `get_task` and dashboard.
- **File:** `agent-collab-mcp/src/tools/tasks.ts`

### 15. Task priority field

- **Problem:** All tasks are equal; `get_my_status` picks by ID order, not importance.
- **Fix:** Add `priority INTEGER DEFAULT 0` column. Sort by `priority DESC` in status queries. Add optional `priority` param to `create_task`.
- **Files:** `agent-collab-mcp/src/db.ts`, `agent-collab-mcp/src/tools/tasks.ts`, `agent-collab-mcp/src/tools/status.ts`

### 16. Task cancellation/archival

- **Problem:** No way to cancel or remove a task without archiving the entire epic.
- **Fix:** Add `cancelled` status to state machine. Add `cancel_task(task_id, reason)` tool. Cancelled tasks hidden from active board but preserved for audit.
- **Files:** `agent-collab-mcp/src/tools/tasks.ts`, `agent-collab-mcp/src/tools/status.ts`, `agent-collab-mcp/src/dashboard.ts`

### 17. Comprehensive test suite

- **Problem:** Zero tests in a ~3,500 LOC coordination system — now even more critical given the dispatch bugs exposed by the field report.
- **Fix:** Add `vitest`, create tests for:
  - `db.test.ts` — role resolution, ID generation, auto-setup
  - `strategies.test.ts` — role config merging, tool access matrices
  - `tasks.test.ts` — state machine transitions, dependency enforcement
  - `reviews.test.ts` — round counting, verdict processing
  - `dispatch.test.ts` — mock spawn, watchdog timeout, CLI existence checks
  - Use in-memory SQLite (`:memory:`) for test isolation
- **Files:** New `agent-collab-mcp/src/__tests__/` directory, `package.json` (add vitest)

---

## Dropped from Original

Lower priority given the field findings — these are code quality or feature work items that should be deferred:

- Deduplicate interfaces (#5), structured errors (#6), centralize JSON parsing (#7) — code quality, less urgent than dispatch fixes
- File reservations (#9), SSE (#10), interactive dashboard (#11), metrics (#12), comments (#13) — feature work
- Epic restore (#15), hot-reload (#16), git branches (#17), webhooks (#18), dashboard auth (#19) — nice-to-haves

---

## Implementation Priority

**Phase 1 — Unblock dispatch (items 1-5):** Create architect agent definition, harden prompt, add watchdog. This directly fixes the 50-minute failure mode. **DONE**

**Phase 2 — Close the review loop (items 6-7):** Auto-dispatch reviews, use existing agent definitions. This ensures the cross-agent review cycle actually runs. **DONE**

**Phase 3 — Observability (items 8-9, 12-13):** Dispatch tracking, structured logs, role validation, log retention. Makes failures visible. **DONE**

**Phase 4 — Safety net (items 14-17):** Dependency enforcement, priority, cancellation, test suite. Prevents repeat incidents and enables confident iteration. **DONE**

**Phase 5 — Architecture (items 10-11):** Document the MCP-vs-agent-definition boundary. Evaluate skills for single-engine mode. **DONE** (item 11 documented as future work — agent definitions preferred over skills for async dispatch)
