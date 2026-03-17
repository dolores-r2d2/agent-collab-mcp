# Agent Collab MCP

Multi-agent coordination system for Cursor and Claude Code. Provides structured task management, review loops, configurable collaboration strategies, and a live dashboard.

## Quick Start (One Command)

Tell your AI agent (Cursor or Claude Code):

> Install the agent-collab MCP from `https://github.com/dolores-r2d2/agent-collab-mcp.git` and set it up for this project.

Or run it yourself:

```bash
git clone https://github.com/dolores-r2d2/agent-collab-mcp.git /tmp/agent-collab && \
  /tmp/agent-collab/init.sh --strategy architect-builder --engines both
```

That's it. The `init.sh` script handles everything:
- Copies the MCP server into your project (`agent-collab-mcp/`)
- Installs dependencies and builds
- Scaffolds config files for Cursor (`.cursor/mcp.json`, hooks, rules) and Claude Code (`.claude/settings.json`, hooks)
- Initializes the SQLite database (`.agent-collab/collab.db`)
- Updates `.gitignore`

After setup, open Cursor or run `claude` — the agent will call `get_my_status` and start working.

> **Both engines need the MCP registered.** `init.sh` and the auto-setup write `.cursor/mcp.json` (for Cursor) **and** `.claude/settings.json` (for Claude Code) automatically. Installing only in Cursor is not sufficient for `both` mode — Claude Code must also have the `agent-collab` server entry in its settings.
>
> If Claude Code reports the tools are missing, call `setup_project(strategy, "both")` from Cursor (or re-run `init.sh`) to regenerate the missing config file.

### Dashboard

The dashboard auto-starts with the MCP server at **http://localhost:4800**. You can also launch it manually:

```bash
scripts/dashboard.sh
```

---

## Setup Options

### Engine Modes

| Mode | Cursor | Claude Code | Use Case |
|------|--------|-------------|----------|
| `both` (default) | Primary role | Secondary role | Two-agent collaboration |
| `cursor-only` | Both roles | Not used | Single-agent in Cursor |
| `claude-code-only` | Not used | Both roles | Single-agent in Claude Code |

```bash
# Examples
init.sh --engines both                # Cursor + Claude Code (default)
init.sh --engines cursor-only         # Cursor only
init.sh --engines claude-code-only    # Claude Code only
```

### Collaboration Strategies

Six research-backed strategies — choose during setup or switch at runtime via `set_strategy()`:

| Strategy | Primary Role | Secondary Role | Best For |
|----------|-------------|---------------|----------|
| `architect-builder` | Builder | Architect / Reviewer | Greenfield projects |
| `tdd-red-green` | Implementer | Test Author | Correctness-critical code |
| `writer-reviewer` | Writer | Multi-Perspective Critic | Security/performance-critical |
| `parallel-specialist` | Specialist A | Specialist B | Full-stack, domain splits |
| `planner-executor` | Executor | Planner / Specifier | Complex systems, refactors |
| `sequential-pipeline` | Implementer | Quality Pipeline Mgr | Enterprise, production code |

```bash
init.sh --strategy tdd-red-green --engines both
```

---

## What Gets Installed

```
your-project/
├── agent-collab-mcp/          # MCP server (Node.js/TypeScript + SQLite)
├── .agent-collab/
│   └── collab.db              # Task/review state database
├── .cursor/
│   ├── mcp.json               # MCP registration (AGENT_ROLE=cursor)
│   ├── hooks/                  # Session hooks (auto-inject next action)
│   └── rules/agent-collab.mdc # Agent behavior rules
├── .claude/
│   ├── settings.json           # MCP registration (AGENT_ROLE=claude-code)
│   └── hooks/                  # Session hooks (review detection)
├── scripts/
│   ├── dashboard.sh            # Dashboard launcher
│   └── orchestrate.sh          # Automated handoff orchestrator
├── CLAUDE.md                   # Claude Code protocol instructions
└── AGENTS.md                   # Strategy & role reference
```

> Files are only created for the selected engine mode. `cursor-only` skips `.claude/` files, etc.

---

## Agent-Friendly Install Instructions

If you're an AI agent asked to install this MCP, here's the exact flow:

1. **Clone** the skeleton repo to a temp location:
   ```bash
   git clone https://github.com/dolores-r2d2/agent-collab-mcp.git /tmp/agent-collab
   ```

2. **Run init.sh** from the target project root:
   ```bash
   cd /path/to/target-project
   /tmp/agent-collab/init.sh --strategy architect-builder --engines both
   ```

3. **Verify** the MCP server is registered:
   - Cursor: check `.cursor/mcp.json` has the `agent-collab` server entry
   - Claude Code: check `.claude/settings.json` has the `agent-collab` server entry

4. **Call `get_my_status`** from the agent-collab MCP to confirm it's working.

No manual steps required. The script is idempotent — safe to re-run.

---

## How It Works

The MCP server uses a SQLite database (`.agent-collab/collab.db`) to manage:

- **Tasks** with a state machine: assigned → in-progress → review → done
- **Reviews** with structured verdicts, file-level issues, severity levels
- **Strategies** that dynamically configure each agent's role, tools, and instructions
- **Activity log** for full audit trail

The server enforces the state machine — agents cannot skip steps or access tools outside their role.

### Typical Workflow (architect-builder, both engines)

1. **Claude Code** (Architect): sets HLD via `set_context`, creates tasks via `create_task`
2. **Cursor** (Builder): calls `get_my_status`, sees tasks, claims with `claim_task`, implements, submits via `submit_for_review`
3. **Claude Code** (Reviewer): reviews with `review_task` — approves or requests changes
4. Repeat until all tasks are done

### Automated Orchestration

For hands-off operation:

```bash
scripts/orchestrate.sh --mode semi   # Claude reviews automatically
scripts/orchestrate.sh --mode full   # Both agents run headless
```

## Troubleshooting

### Claude Code doesn't see the agent-collab MCP tools

Both engines require separate MCP registrations pointing to the same database. Symptoms: Claude Code only shows built-in tools; `get_my_status` is not available.

**Cause:** The MCP was installed via Cursor but `.claude/settings.json` was never written (common when the project was set up before v2.0.2 or when `engine_mode` was incorrectly inferred as `cursor-only`).

**Fix:**
1. From Cursor, call `setup_project("architect-builder", "both")` — this re-scaffolds `.claude/settings.json` alongside the Cursor config.
2. Or re-run `init.sh --engines both` from the project root.
3. Restart Claude Code after the file is written.

You can verify `.claude/settings.json` contains the registration:
```bash
cat .claude/settings.json | grep agent-collab
```

### `get_my_status` shows a `⚠ MISSING CONFIG` warning

This warning appears when the engine mode is `both` but the counterpart engine's config file is absent or doesn't contain the `agent-collab` entry. Follow the fix above.

### MCP auto-setup used the wrong engine mode

Early versions inferred `engine_mode` from `AGENT_ROLE`, which caused Cursor-first installs to be set as `cursor-only`. Fixed in v2.0.2. To reset: call `setup_project(strategy, "both")` from Cursor.

## License

MIT
