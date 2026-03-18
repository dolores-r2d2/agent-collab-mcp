# Agent-Collab MCP — Architecture

## System Overview

```
+---------------------------+       +---------------------------+
|      Cursor (IDE)         |       |    Claude Code (CLI)      |
|  Role: Primary / Builder  |       | Role: Secondary / Reviewer|
|                           |       |                           |
|  .cursor/mcp.json -----+ |       | +---- .claude/settings.json|
+-------------|------------+        +-------------|-------------+
              |    MCP (stdio)                    |   MCP (stdio)
              v                                   v
        +---------------------------------------------+
        |         agent-collab MCP Server              |
        |  (node ./agent-collab-mcp/build/index.js)    |
        |                                              |
        |  AGENT_ROLE=cursor  |  AGENT_ROLE=claude-code|
        |  (separate process)    (separate process)    |
        +----------------------|-----------------------+
                               |
                               v
                 +----------------------------+
                 |  .agent-collab/collab.db    |
                 |  (SQLite — WAL mode)       |
                 +----------------------------+
```

Two separate MCP server processes run simultaneously — one per engine — but share the same SQLite database. The `AGENT_ROLE` environment variable determines which tools each instance exposes.

---

## Startup Flow

```
index.ts
  |
  |-- isInitialized()?
  |     |
  |     NO --> autoSetup()
  |     |       |-- getDb() --> create .agent-collab/collab.db
  |     |       |-- migrate() --> create 11 tables
  |     |       |-- setEngineMode("both")
  |     |       |-- setActiveStrategy("architect-builder")
  |     |       |-- prune activity_log (keep 500)
  |     |       '-- writeProjectFiles() --> scaffold configs
  |     |
  |     YES --> getDb() --> migrate if needed
  |
  |-- Read strategy, engineMode, roleConfig
  |-- Create McpServer with role-specific instructions
  |-- Register all tool modules:
  |     status, setup, tasks, reviews, context,
  |     strategy, dispatch, epic, reservations,
  |     comments, metrics
  |-- Connect via StdioServerTransport
  '-- Auto-start dashboard (port 4800)
```

---

## Database Schema (11 tables)

```
+------------------+     +------------------+     +------------------+
|     tasks        |     |    reviews       |     | task_transitions |
+------------------+     +------------------+     +------------------+
| id (PK)          |<-+--| task_id (FK)     |     | task_id          |
| title            |  |  | round            |     | from_status      |
| status           |  |  | verdict          |     | to_status        |
| owner            |  |  | issues (JSON)    |     | agent            |
| depends_on       |  |  | notes            |     | transitioned_at  |
| context          |  |  | created_at       |     +------------------+
| acceptance       |  |  +------------------+
| plan             |  |
| summary          |  |  +------------------+     +------------------+
| priority         |  +--| file_reservations|     |  task_comments   |
| created_at       |  |  +------------------+     +------------------+
| updated_at       |  |  | path (PK)        |     | task_id (FK)     |
+------------------+  +--| task_id (FK)     |     | agent            |
                      |  | reserved_at      |     | message          |
                      |  +------------------+     | created_at       |
                      |                           +------------------+
+------------------+  |
|  context_docs    |  |  +------------------+     +------------------+
+------------------+  |  |   dispatches     |     |  activity_log    |
| key (PK)         |  |  +------------------+     +------------------+
| content          |  |  | id (PK)          |     | id (PK)          |
| version          |  |  | pid              |     | timestamp        |
| updated_by       |  |  | role             |     | agent            |
| updated_at       |  |  | log_file         |     | action           |
+------------------+  |  | status           |     +------------------+
                      |  | created_at       |
+------------------+  |  | completed_at     |     +------------------+
|     config       |  |  +------------------+     |     epics        |
+------------------+  |                           +------------------+
| key (PK)         |  |  +------------------+     | id (PK)          |
| value            |  +--| epic_tasks       |     | name             |
+------------------+     +------------------+     | description      |
                         | epic_id (FK) ----+---->| task_count       |
                         | task_id          |     | context_json     |
                         | title, status... |     | activity_json    |
                         +------------------+     | archived_at      |
                                                  +------------------+
```

### Key config entries

| Key | Default | Purpose |
|-----|---------|---------|
| `strategy` | `architect-builder` | Active collaboration strategy |
| `engine_mode` | `both` | `both`, `cursor-only`, or `claude-code-only` |
| `dispatch_timeout_seconds` | `300` | Watchdog timeout per dispatch |
| `max_review_rounds` | `5` | Auto-approve after N rejected rounds |
| `auto_dispatch_review` | `true` | Auto-dispatch reviewer on submit |

---

## Task State Machine

```
                 create_task
                     |
                     v
              +------------+
              |  assigned   |<--------------------+
              +-----+------+                      |
                    |                              |
              claim_task                           |
                    |                              |
                    v                              |
            +--------------+                       |
            | in-progress  |                       |
            +------+-------+                       |
                   |                               |
          submit_for_review                        |
                   |                               |
                   v                               |
            +----------+                           |
            |  review   |                          |
            +----+-----+                           |
                 |                                 |
           review_task                             |
            /        \                             |
           v          v                            |
    +------+    +-----+-----------+                |
    | done |    | changes-requested|----claim_task--+
    +------+    +-----------------+

                cancel_task (from any non-terminal state)
                     |
                     v
              +-----------+
              | cancelled  |
              +-----------+
```

Each transition is recorded in `task_transitions` for audit.

---

## Collaboration Strategies

```
+-------------------------------------------------------------------+
|                     Strategy Layer                                 |
|                                                                   |
|  Each strategy defines:                                           |
|    - Primary role (name, instructions, tool access)               |
|    - Secondary role (name, instructions, tool access)             |
|                                                                   |
|  Engine mode maps physical engines to abstract roles:             |
|    both:             cursor=Primary, claude-code=Secondary        |
|    cursor-only:      cursor=Primary+Secondary (merged)            |
|    claude-code-only: claude-code=Primary+Secondary (merged)       |
+-------------------------------------------------------------------+

+---------------------+  +---------------------+  +---------------------+
| architect-builder   |  | tdd-red-green       |  | writer-reviewer     |
| (default)           |  |                     |  |                     |
| Primary: Builder    |  | Primary: Green      |  | Primary: Writer     |
| Secondary: Architect|  | Secondary: Red      |  | Secondary: Critic   |
|   & Reviewer        |  |   & Reviewer        |  |  (multi-perspective)|
+---------------------+  +---------------------+  +---------------------+

+---------------------+  +---------------------+  +---------------------+
| parallel-specialist |  | planner-executor    |  | sequential-pipeline |
|                     |  |                     |  |                     |
| Primary: Spec A     |  | Primary: Executor   |  | Primary: Implementer|
| Secondary: Spec B   |  | Secondary: Planner  |  | Secondary: Quality  |
| (both can create,   |  |   & Specifier       |  |   Pipeline Manager  |
|  claim, & review)   |  |                     |  | (4-stage review)    |
+---------------------+  +---------------------+  +---------------------+
```

### Tool Access Matrix (architect-builder)

| Tool | Builder (Primary) | Architect (Secondary) | Single-engine |
|------|:-:|:-:|:-:|
| `create_task` | - | Y | Y |
| `claim_task` | Y | - | Y |
| `submit_for_review` | Y | - | Y |
| `review_task` | - | Y | Y |
| `set_context` | - | Y | Y |
| `save_plan` | Y | - | Y |

---

## Dispatch System (Cross-Agent Orchestration)

```
  Cursor (Builder)                          Claude Code (Architect/Reviewer)
       |                                              |
       |  submit_for_review(T-001)                    |
       |  ---auto_dispatch_review--->                 |
       |                                              |
       |    dispatchAgent("reviewer", prompt)          |
       |        |                                     |
       |        |-- validateMcpConfig("claude-code")  |
       |        |     |-- check .claude/settings.json |
       |        |     '-- auto-repair if missing      |
       |        |                                     |
       |        |-- spawn("claude", ["-p", prompt])   |
       |        |     (detached background process)   |
       |        |                                     |
       |        |-- recordDispatch(pid, "reviewer")   |
       |        |                                     |
       |        '-- startWatchdog(child, dispatchId)  |
       |              |                               |
       |              |-- immediate PID check (1s)    |
       |              |-- poll every 30s:              |
       |              |     - PID alive?               |
       |              |     - DB progress?             |
       |              |     - timeout exceeded?        |
       |              '-- completeDispatch(status)     |
       |                                              |
       |                         get_my_status -------|
       |                         get_task(T-001) -----|
       |                         review_task(T-001) --|
       |                                              |
       |  <--- get_my_status (sees "changes-requested")
       |
```

### Dispatch Types

| Function | Triggers | Target | Watchdog Metric |
|----------|----------|--------|-----------------|
| `dispatchReview(taskIds)` | `submit_for_review`, `trigger_review` | Opposite engine | `COUNT(*) FROM reviews` |
| `dispatchBuilder(taskIds)` | `create_task(notify_builder=true)`, `notify_builder` | Opposite engine | `COUNT(*) FROM tasks WHERE status='in-progress'` |
| `dispatchArchitect(request)` | `invoke_architect` | claude-code (via `dispatchAgent`) | `COUNT(*) FROM tasks` |

### Stale Dispatch Cleanup

```
get_my_status()
  |
  +-- cleanupStaleDispatches()
        |
        |-- Mark dispatches older than 2x timeout as 'failed'
        |-- Check remaining 'running' PIDs:
        |     kill(pid, 0)  -- signal 0 = alive check
        |     dead? --> mark 'failed'
        '-- Return { cleaned: N }
```

---

## MCP Config Auto-Repair

```
validateMcpConfig(target)
  |
  +-- File exists?
  |     |
  |     NO --> tryWriteConfig()
  |     |       |-- Create directory
  |     |       |-- Write minimal config with agent-collab entry
  |     |       '-- Return { ok: true, repaired: true }
  |     |
  |     YES --> Contains "agent-collab"?
  |               |
  |               YES --> { ok: true }
  |               |
  |               NO --> mergeAgentCollabEntry()
  |                       |-- Parse existing JSON
  |                       |-- Add mcpServers["agent-collab"]
  |                       |-- Write back (preserves other servers)
  |                       '-- { ok: true, repaired: true }
```

---

## Review Loop with Max Rounds Guard

```
review_task(task_id, verdict="changes-requested")
  |
  +-- round = last_round + 1
  |
  +-- round >= max_review_rounds (default: 5)?
  |     |
  |     YES --> effectiveVerdict = "approved" (auto-approve)
  |     |       log warning to activity_log
  |     |
  |     NO --> effectiveVerdict = "changes-requested"
  |
  +-- INSERT review, UPDATE task status
  '-- Return result with round/maxRounds indicator
```

---

## File Layout

```
agent-collab-mcp/
  src/
    index.ts              Entry point — MCP server + dashboard launcher
    db.ts                 SQLite init, migrations, role/config helpers
    dispatch.ts           Cross-agent CLI spawning, watchdog, config repair
    strategies.ts         6 collaboration strategy definitions
    templates.ts          Embedded config templates for scaffolding
    dashboard.ts          Web UI server (port 4800)
    logger.ts             File-based structured logging
    errors.ts             Shared error constructors
    types.ts              TypeScript interfaces for DB rows
    utils.ts              Issue parsing, formatting helpers
    tools/
      status.ts           get_my_status, get_project_overview
      tasks.ts            create_task, claim_task, submit_for_review, etc.
      reviews.ts          review_task, get_review_feedback
      context.ts          get_context, set_context, log_activity
      dispatch.ts         trigger_review, notify_builder, invoke_architect, run_loop
      setup.ts            setup_project, get_dashboard_info
      strategy.ts         list_strategies, get_active_strategy, set_strategy
      epic.ts             archive_epic, list_epics, get_epic
      reservations.ts     reserve_files, release_files, check_conflicts
      comments.ts         add_comment, get_comments
      metrics.ts          get_metrics, get_codebase_context
    __tests__/
      *.test.ts           14 test files, 112 tests

Scaffolded project files:
  .agent-collab/collab.db       SQLite database (gitignored)
  .cursor/mcp.json              Cursor MCP config
  .claude/settings.json         Claude Code MCP config
  scripts/dashboard.sh          Dashboard launcher
  scripts/orchestrate.sh        Batch orchestration script
  scripts/logs/                 Dispatch and dashboard logs (gitignored)
```

---

## Context Doc Versioning

```
context_docs
  key: "hld"
  content: "..."
  version: 3           <-- auto-incremented on each set_context
  updated_by: "claude-code"
  updated_at: "2026-03-18T..."
```

Agents can detect staleness by comparing the version they read against the current version before acting on the document.

---

## Data Flow: Full Feature Lifecycle

```
1. User tells Cursor: "Build a REST API for users"

2. Cursor (Builder) calls invoke_architect("Build a REST API for users")
     |
     '--> dispatchAgent --> spawns Claude Code in background

3. Claude Code (Architect) runs:
     get_my_status()
     set_context("hld", "REST API design...")        --> context_docs (v1)
     create_task("GET /users endpoint", ...)          --> tasks T-001
     create_task("POST /users endpoint", ...)         --> tasks T-002
     create_task("Auth middleware", notify_builder=true) --> tasks T-003
       '--> dispatchBuilder([T-001, T-002, T-003])

4. Cursor (Builder) picks up:
     get_my_status()                                  --> sees T-001 assigned
     claim_task("T-001")                              --> T-001 in-progress
     save_plan("T-001", "1. Create route...")
     [implements code]
     submit_for_review("T-001", "Added GET /users")   --> T-001 review
       '--> dispatchReview([T-001])

5. Claude Code (Reviewer) reviews:
     get_my_status()                                  --> sees T-001 in review
     get_task("T-001")                                --> reads details
     review_task("T-001", "changes-requested",        --> T-001 changes-requested
       issues: [{file: "src/routes.ts", line: 15,
                 description: "Missing pagination"}])

6. Cursor (Builder) fixes:
     get_my_status()                                  --> sees changes-requested
     claim_task("T-001")                              --> T-001 in-progress
     get_review_feedback("T-001")                     --> reads issues
     [fixes code]
     submit_for_review("T-001", "Added pagination")   --> T-001 review
       '--> dispatchReview([T-001])

7. Claude Code (Reviewer):
     review_task("T-001", "approved",                 --> T-001 done
       notes: "Looks good!")
     [file_reservations cleared]

8. Repeat for T-002, T-003...

9. All done:
     archive_epic("User API")                         --> snapshot to epics table
                                                          clear active tasks
```
