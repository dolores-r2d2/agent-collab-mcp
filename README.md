# Agent Collab MCP

Multi-agent coordination system for Cursor and Claude Code. Provides structured task management, review loops, configurable collaboration strategies, and a live dashboard.

## Quick Start

### 1. Add the MCP server to your project

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agent-collab": {
      "command": "npx",
      "args": ["-y", "agent-collab-mcp"],
      "env": {
        "AGENT_ROLE": "cursor"
      }
    }
  }
}
```

### 2. Open Cursor

Cursor will detect the MCP server and walk you through setup — asking which collaboration strategy and engine mode you want.

### 3. Start working

The agent will manage the full workflow: creating tasks, implementing, reviewing, and iterating.

### 4. Dashboard

After setup, launch the live task board:

```bash
scripts/dashboard.sh
# → http://localhost:4800
```

## Engine Modes

| Mode | Description |
|------|-------------|
| `cursor-only` | Cursor handles both roles (default for single-agent setup) |
| `both` | Cursor = Primary, Claude Code = Secondary |
| `claude-code-only` | Claude Code handles both roles |

For `both` mode, also add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "agent-collab": {
      "command": "npx",
      "args": ["-y", "agent-collab-mcp"],
      "env": {
        "AGENT_ROLE": "claude-code"
      }
    }
  }
}
```

## Collaboration Strategies

Six research-backed strategies — choose during setup or switch at runtime via MCP tools:

| Strategy | Primary Role | Secondary Role | Best For |
|----------|-------------|---------------|----------|
| `architect-builder` | Builder | Architect / Reviewer | Greenfield projects |
| `tdd-red-green` | Implementer | Test Author | Correctness-critical code |
| `writer-reviewer` | Writer | Multi-Perspective Critic | Security/performance-critical |
| `parallel-specialist` | Specialist A | Specialist B | Full-stack, domain splits |
| `planner-executor` | Executor | Planner / Specifier | Complex systems, refactors |
| `sequential-pipeline` | Implementer | Quality Pipeline Mgr | Enterprise, production code |

## CLI Alternative

If you prefer CLI setup over Cursor-interactive:

```bash
git clone https://github.com/user/agent-collab-mcp.git /tmp/agent-collab
cd your-project
/tmp/agent-collab/init.sh --strategy architect-builder --engines cursor-only
```

## How It Works

The MCP server uses a SQLite database (`.agent-collab/collab.db`) to manage:

- **Tasks** with a state machine: assigned → in-progress → review → done
- **Reviews** with structured verdicts, file-level issues, severity levels
- **Strategies** that dynamically configure each agent's role, tools, and instructions
- **Activity log** for full audit trail

The server enforces the state machine — agents cannot skip steps or access tools outside their role.

## License

MIT
