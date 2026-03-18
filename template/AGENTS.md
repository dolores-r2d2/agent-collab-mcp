# Agent Instructions

## Engine Modes

The system supports three engine modes, set at init time or dynamically via MCP:

| Mode | Description |
|------|-------------|
| `both` (default) | Cursor = Primary role, Claude Code = Secondary role |
| `cursor-only` | Cursor handles both Primary and Secondary roles |
| `claude-code-only` | Claude Code handles both Primary and Secondary roles |

In single-engine mode, the active agent gets **all tools** and **merged instructions** from both roles. Self-review is used instead of cross-agent handoffs.

## Roles

Roles are defined by the active **collaboration strategy** using abstract names: **Primary** and **Secondary**. The engine mode maps physical engines to these abstract roles.

In `both` mode:
- **Cursor** → Primary role
- **Claude Code** → Secondary role

In single-engine mode, the one active engine fills both roles.

## Task Status State Machine

```
assigned ──► in-progress ──► review ──► done
                 ▲               │
                 │               ▼
                 └─── changes-requested
```

State transitions are **enforced by the MCP server**. Invalid transitions are rejected.

## Coordination — MCP Server

All coordination goes through the `agent-collab` MCP server (backed by SQLite).
Each agent calls targeted MCP tools. The server returns role-aware instructions.

**First tool call in any session:** `get_my_status` — tells you exactly what to do next.

## Collaboration Strategies

The system supports 6 research-backed strategies. Strategies use abstract role names (Primary / Secondary), not engine names.

### Architect–Builder (default) `architect-builder`
One agent designs the architecture and reviews. The other implements.
- **Primary:** Builder — claims tasks, implements, submits for review
- **Secondary:** Architect / Reviewer — creates HLD, tasks, reviews
- **Best for:** Greenfield projects, well-defined features
- **Research:** MetaGPT SOP-based roles (85.9% Pass@1), Anthropic Plan/Execute split

### TDD Red–Green `tdd-red-green`
One agent writes failing tests first. The other makes them pass.
- **Primary:** Implementer (Green) — makes tests pass without modifying them
- **Secondary:** Test Author (Red) — writes test specs, reviews coverage
- **Best for:** Bug-prone domains, APIs, data processing
- **Research:** TDD-on-autopilot — tests as machine-verifiable specs

### Writer–Reviewer (Critique Loop) `writer-reviewer`
One agent generates code. The other critiques from multiple perspectives. Iterates until converged.
- **Primary:** Writer / Generator — writes and iterates on feedback
- **Secondary:** Multi-Perspective Critic — security, performance, correctness, tests, maintainability
- **Best for:** Security-sensitive features, performance-critical code
- **Research:** Constitutional AI debate patterns, Writer/Reviewer loop (Devin: 34% → 67% merge rate)

### Parallel Specialists `parallel-specialist`
Each agent owns a domain. Both create and implement tasks. Cross-review each other.
- **Primary:** Specialist A — owns one domain, cross-reviews the other
- **Secondary:** Specialist B — owns the other domain, sets HLD, cross-reviews
- **Best for:** Full-stack features, microservices, clear domain boundaries
- **Research:** Google Parallel Pattern, Gas Town 20-30 agent management, file reservation

### Planner–Executor `planner-executor`
One agent produces exhaustively detailed plans. The other executes mechanically.
- **Primary:** Executor — translates specs to code exactly as written
- **Secondary:** Planner / Specifier — pseudocode, contracts, file-by-file specs
- **Best for:** Complex systems, large refactors, maximum architectural control
- **Research:** Anthropic Plan/Execute split, hierarchical decomposition (58% faster, 34% higher completion)

### Sequential Quality Pipeline `sequential-pipeline`
One agent implements. The other runs multi-stage quality review.
- **Primary:** Implementer — iterates through quality stages
- **Secondary:** Quality Pipeline Manager — security → performance → tests → architecture
- **Best for:** Enterprise/production code, security-critical applications
- **Research:** Google Sequential Pattern, multi-perspective specialized review

## Configuration

```bash
# At init time
init.sh --strategy tdd-red-green --engines cursor-only

# Engine mode options
init.sh --engines both              # (default) Two engines
init.sh --engines cursor-only       # Cursor handles everything
init.sh --engines claude-code-only  # Claude Code handles everything

# At runtime via MCP tools
set_strategy("writer-reviewer", confirm=true)
set_engine_mode("cursor-only", confirm=true)

# Via environment variables
AGENT_STRATEGY=parallel-specialist
AGENT_ENGINE_MODE=cursor-only
```

## Constraint Model: MCP vs Agent Definitions

Role-based constraints operate at two levels:

| Layer | Mechanism | Controls | Enforced by |
|-------|-----------|----------|-------------|
| **MCP Server** | Role-based tool access in `strategies.ts` | Which MCP tools each role can call | MCP server (hard enforcement) |
| **Agent Definition** | `allowedTools` in `.claude/agents/*.md` | Which built-in tools the agent can use (Read, Write, Edit, Bash, etc.) | Claude Code CLI (hard enforcement) |

An MCP server **cannot** restrict an agent's built-in tools. For constrained roles (architect, reviewer), both layers must be configured:

- **MCP role** determines available MCP tools (e.g. architect can `create_task` but not `claim_task`)
- **Agent definition** determines available non-MCP tools (e.g. architect can `Read` and `Grep` but not `Write` or `Bash`)

For Cursor, `.cursor/rules/*.mdc` provides behavioral constraints but they are advisory, not enforced.

### Agent Definitions

| Agent | File | Built-in Tools | Purpose |
|-------|------|---------------|---------|
| `architect` | `.claude/agents/architect.md` | Read, Glob, Grep | Designs HLD, creates tasks. No file writes. |
| `task-reviewer` | `.claude/agents/task-reviewer.md` | Read, Glob, Grep | Reviews implementations. No file writes. |

### Dispatch Permissions

Dispatched agents use `--permission-mode bypassPermissions` because their `allowedTools` already constrain them. This avoids the deadlock where `--permission-mode auto` blocks on shell approval for a detached process that has no human to approve.

## Automation

### Semi-Automated (`scripts/orchestrate.sh --mode semi`)
Orchestrator reads SQLite, invokes `claude -p` for reviews. Cursor fixes manually.

### Fully-Automated (`scripts/orchestrate.sh --mode full`)
Both agents run headlessly. Loops until all tasks pass review.

### Pre-requisites
- Node.js (for MCP server)
- `claude` CLI authenticated (`claude status`) — not needed for `cursor-only`
- `agent` CLI with `CURSOR_API_KEY` (for `--mode full`)

### Running
```bash
scripts/orchestrate.sh --mode semi
scripts/orchestrate.sh --mode full --max-rounds 3
scripts/orchestrate.sh --task T-001
scripts/orchestrate.sh --mode full --dry-run
```
