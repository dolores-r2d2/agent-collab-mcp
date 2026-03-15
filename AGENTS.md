# Agent Instructions

## Roles

Roles are defined by the active **collaboration strategy**. The strategy determines what each agent can do (tool access) and how they work together.

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

The system supports 6 research-backed strategies. Choose at init time or change dynamically.

### Architect–Builder (default) `architect-builder`
Claude Code designs the architecture and reviews. Cursor implements.
- **Claude Code:** Architect / Reviewer — creates HLD, tasks, reviews
- **Cursor:** Builder — claims tasks, implements, submits for review
- **Best for:** Greenfield projects, well-defined features
- **Research:** MetaGPT SOP-based roles (85.9% Pass@1), Anthropic Plan/Execute split

### TDD Red–Green `tdd-red-green`
Claude Code writes failing tests first. Cursor makes them pass. Claude reviews coverage.
- **Claude Code:** Test Author (Red) — writes test specs, reviews coverage
- **Cursor:** Implementer (Green) — makes tests pass without modifying them
- **Best for:** Bug-prone domains, APIs, data processing
- **Research:** TDD-on-autopilot — tests as machine-verifiable specs

### Writer–Reviewer (Critique Loop) `writer-reviewer`
Cursor generates code. Claude Code critiques from multiple perspectives. Iterates until converged.
- **Claude Code:** Multi-Perspective Critic — security, performance, correctness, tests, maintainability
- **Cursor:** Writer / Generator — writes and iterates on feedback
- **Best for:** Security-sensitive features, performance-critical code
- **Research:** Constitutional AI debate patterns, Writer/Reviewer loop (Devin: 34% → 67% merge rate)

### Parallel Specialists `parallel-specialist`
Each agent owns a domain. Both create and implement tasks. Cross-review each other.
- **Claude Code:** Backend / Infrastructure Specialist
- **Cursor:** Frontend / UI Specialist
- **Best for:** Full-stack features, microservices, clear domain boundaries
- **Research:** Google Parallel Pattern, Gas Town 20-30 agent management, file reservation

### Planner–Executor `planner-executor`
Claude Code produces exhaustively detailed plans. Cursor executes mechanically.
- **Claude Code:** Planner / Specifier — pseudocode, contracts, file-by-file specs
- **Cursor:** Executor — translates specs to code exactly as written
- **Best for:** Complex systems, large refactors, maximum architectural control
- **Research:** Anthropic Plan/Execute split, hierarchical decomposition (58% faster, 34% higher completion)

### Sequential Quality Pipeline `sequential-pipeline`
Cursor implements. Claude Code runs multi-stage quality review.
- **Claude Code:** Quality Pipeline Manager — security → performance → tests → architecture
- **Cursor:** Implementer — iterates through quality stages
- **Best for:** Enterprise/production code, security-critical applications
- **Research:** Google Sequential Pattern, multi-perspective specialized review

## Switching Strategies

```bash
# At init time
init.sh --strategy tdd-red-green

# At runtime (Claude Code calls via MCP)
set_strategy("writer-reviewer", confirm=true)

# Via environment variable
AGENT_STRATEGY=parallel-specialist
```

## Automation

### Semi-Automated (`scripts/orchestrate.sh --mode semi`)
Orchestrator reads SQLite, invokes `claude -p` for reviews. Cursor fixes manually.

### Fully-Automated (`scripts/orchestrate.sh --mode full`)
Both agents run headlessly. Loops until all tasks pass review.

### Pre-requisites
- Node.js (for MCP server)
- `claude` CLI authenticated (`claude status`)
- `agent` CLI with `CURSOR_API_KEY` (for `--mode full`)

### Running
```bash
scripts/orchestrate.sh --mode semi
scripts/orchestrate.sh --mode full --max-rounds 3
scripts/orchestrate.sh --task T-001
scripts/orchestrate.sh --mode full --dry-run
```
