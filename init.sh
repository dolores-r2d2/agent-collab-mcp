#!/usr/bin/env bash
set -euo pipefail

# ── Agent Collaboration Skeleton — CLI Bootstrapper ──────────────────────────
# Installs the MCP-based multi-agent coordination system into the current project.
#
# ALTERNATIVE: For Cursor-interactive setup (no CLI needed), just add to .cursor/mcp.json:
#   { "mcpServers": { "agent-collab": { "command": "npx", "args": ["-y", "agent-collab-mcp"],
#     "env": { "AGENT_ROLE": "cursor" } } } }
# Then open Cursor — it will walk you through setup interactively.
#
# Usage:
#   /path/to/agent-collab-skeleton/init.sh [--project-name NAME] [--strategy ID] [--engines MODE]
#
# Engines:
#   both              (default) Cursor = Primary role, Claude Code = Secondary role
#   cursor-only       Cursor handles both roles (no Claude Code needed)
#   claude-code-only  Claude Code handles both roles (no Cursor needed)
#
# Strategies:
#   architect-builder    (default) One agent designs, the other builds
#   tdd-red-green        One writes failing tests, the other makes them pass
#   writer-reviewer      One writes, the other critiques from multiple perspectives
#   parallel-specialist  Domain split — each agent owns a domain, cross-reviews
#   planner-executor     One writes detailed specs, the other executes mechanically
#   sequential-pipeline  Multi-stage quality pipeline (security → perf → tests → arch)
#
# Run this from your project root directory.
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_NAME=""
STRATEGY=""
ENGINES=""

VALID_STRATEGIES="architect-builder tdd-red-green writer-reviewer parallel-specialist planner-executor sequential-pipeline"
VALID_ENGINES="both cursor-only claude-code-only"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-name) PROJECT_NAME="$2"; shift 2 ;;
    --strategy)
      STRATEGY="$2"
      if ! echo "$VALID_STRATEGIES" | grep -qw "$STRATEGY"; then
        echo -e "${RED}Unknown strategy: $STRATEGY${NC}"
        echo -e "Valid strategies: ${CYAN}${VALID_STRATEGIES}${NC}"
        exit 1
      fi
      shift 2
      ;;
    --engines)
      ENGINES="$2"
      if ! echo "$VALID_ENGINES" | grep -qw "$ENGINES"; then
        echo -e "${RED}Unknown engine mode: $ENGINES${NC}"
        echo -e "Valid modes: ${CYAN}${VALID_ENGINES}${NC}"
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      head -24 "$0" | tail -22
      exit 0
      ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

if [[ -z "$PROJECT_NAME" ]]; then
  PROJECT_NAME=$(basename "$(pwd)")
fi

if [[ -z "$ENGINES" ]]; then
  ENGINES="both"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/template"
MCP_SRC="$SCRIPT_DIR/agent-collab-mcp"

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo -e "${RED}Error: template/ directory not found at $TEMPLATE_DIR${NC}"
  exit 1
fi

if [[ ! -d "$MCP_SRC" ]]; then
  echo -e "${RED}Error: agent-collab-mcp/ directory not found at $MCP_SRC${NC}"
  exit 1
fi

echo ""
echo -e "${BOLD}Agent Collaboration Skeleton — Init (MCP)${NC}"
echo -e "Project:  ${CYAN}$PROJECT_NAME${NC}"
echo -e "Target:   ${CYAN}$(pwd)${NC}"
echo -e "Engines:  ${CYAN}$ENGINES${NC}"
if [[ -n "$STRATEGY" ]]; then
  echo -e "Strategy: ${CYAN}$STRATEGY${NC}"
fi
echo ""

# ── Pre-flight checks ───────────────────────────────────────────────────────
if command -v node &>/dev/null; then
  echo -e "${GREEN}✓${NC} Node.js found: $(node --version)"
else
  echo -e "${RED}✗${NC} Node.js not found — required for the MCP server"
  exit 1
fi

if [[ "$ENGINES" == "both" ]] || [[ "$ENGINES" == "claude-code-only" ]]; then
  if command -v claude &>/dev/null; then
    echo -e "${GREEN}✓${NC} claude CLI found: $(which claude)"
  else
    echo -e "${YELLOW}!${NC} claude CLI not found — install it for Claude Code integration"
  fi
fi

echo ""

# ── Copy MCP server ─────────────────────────────────────────────────────────
echo -e "${BOLD}Installing MCP server:${NC}"

if [[ -d "agent-collab-mcp" ]]; then
  echo -e "  ${YELLOW}skip${NC}  agent-collab-mcp/ (already exists)"
else
  cp -r "$MCP_SRC" ./agent-collab-mcp
  echo -e "  ${GREEN}create${NC} agent-collab-mcp/"
fi

# ── Copy template config files (based on engine mode) ───────────────────────
echo ""
echo -e "${BOLD}Copying config files:${NC}"

created=0
skipped=0

copy_file() {
  local src="$1"
  local rel="${src#$TEMPLATE_DIR/}"
  local dest="$(pwd)/$rel"
  local dest_dir
  dest_dir=$(dirname "$dest")

  mkdir -p "$dest_dir"

  if [[ -f "$dest" ]]; then
    echo -e "  ${YELLOW}skip${NC}  $rel (already exists)"
    skipped=$((skipped + 1))
  else
    cp "$src" "$dest"
    echo -e "  ${GREEN}create${NC} $rel"
    created=$((created + 1))
  fi
}

should_copy_file() {
  local rel="$1"
  case "$ENGINES" in
    cursor-only)
      # Skip Claude Code config files
      if [[ "$rel" == .claude/* ]] || [[ "$rel" == CLAUDE.md ]]; then
        return 1
      fi
      ;;
    claude-code-only)
      # Skip Cursor config files
      if [[ "$rel" == .cursor/* ]]; then
        return 1
      fi
      ;;
  esac
  return 0
}

while IFS= read -r -d '' file; do
  rel="${file#$TEMPLATE_DIR/}"
  if should_copy_file "$rel"; then
    copy_file "$file"
  else
    echo -e "  ${YELLOW}skip${NC}  $rel (not needed for $ENGINES)"
  fi
done < <(find "$TEMPLATE_DIR" -type f -print0 | sort -z)

# ── Install and build MCP server ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}Building MCP server:${NC}"

if [[ ! -d "agent-collab-mcp/node_modules" ]]; then
  echo -e "  Installing dependencies..."
  (cd agent-collab-mcp && npm install --silent 2>&1) || {
    echo -e "  ${RED}Failed to install dependencies${NC}"
    exit 1
  }
  echo -e "  ${GREEN}✓${NC} Dependencies installed"
else
  echo -e "  ${YELLOW}skip${NC}  node_modules already exist"
fi

if [[ ! -d "agent-collab-mcp/build" ]] || [[ "agent-collab-mcp/src/index.ts" -nt "agent-collab-mcp/build/index.js" ]]; then
  echo -e "  Compiling TypeScript..."
  (cd agent-collab-mcp && npm run build --silent 2>&1) || {
    echo -e "  ${RED}Failed to build${NC}"
    exit 1
  }
  echo -e "  ${GREEN}✓${NC} Build complete"
else
  echo -e "  ${YELLOW}skip${NC}  build is up to date"
fi

# ── Create runtime directories ───────────────────────────────────────────────
mkdir -p scripts/logs .agent-collab

# ── Set strategy and engine mode in DB ───────────────────────────────────────
echo ""
echo -e "${BOLD}Configuring:${NC}"

if command -v sqlite3 &>/dev/null; then
  sqlite3 ".agent-collab/collab.db" "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);"

  # Engine mode
  sqlite3 ".agent-collab/collab.db" "INSERT OR REPLACE INTO config (key, value) VALUES ('engine_mode', '$ENGINES');"
  echo -e "  ${GREEN}✓${NC} Engine mode: $ENGINES"

  # Strategy
  if [[ -n "$STRATEGY" ]]; then
    sqlite3 ".agent-collab/collab.db" "INSERT OR REPLACE INTO config (key, value) VALUES ('strategy', '$STRATEGY');"
    echo -e "  ${GREEN}✓${NC} Strategy: $STRATEGY"
  fi
else
  echo -e "  ${YELLOW}!${NC} sqlite3 not found — using env vars for configuration"
  echo -e "  Set AGENT_ENGINE_MODE=$ENGINES in your MCP server config"
  if [[ -n "$STRATEGY" ]]; then
    echo -e "  Set AGENT_STRATEGY=$STRATEGY in your MCP server config"
  fi
fi

# ── Add to .gitignore ────────────────────────────────────────────────────────
if [[ -f ".gitignore" ]]; then
  for entry in ".agent-collab/" "agent-collab-mcp/node_modules/" "agent-collab-mcp/build/" "scripts/logs/"; do
    if ! grep -qF "$entry" .gitignore 2>/dev/null; then
      echo "$entry" >> .gitignore
      echo -e "  ${GREEN}+${NC} Added $entry to .gitignore"
    fi
  done
fi

# ── Make scripts executable ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Setting permissions:${NC}"

for script in scripts/orchestrate.sh scripts/dashboard.sh; do
  if [[ -f "$script" ]]; then
    chmod +x "$script"
    echo -e "  ${GREEN}chmod +x${NC} $script"
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Done!${NC} Created $created file(s), skipped $skipped existing."
echo ""
echo -e "${BOLD}What was installed:${NC}"
echo -e "  agent-collab-mcp/     MCP server (SQLite-backed task coordination)"
case "$ENGINES" in
  both)
    echo -e "  .cursor/mcp.json      Cursor MCP registration (Primary role)"
    echo -e "  .claude/settings.json Claude Code MCP registration (Secondary role)"
    ;;
  cursor-only)
    echo -e "  .cursor/mcp.json      Cursor MCP registration (handles BOTH roles)"
    ;;
  claude-code-only)
    echo -e "  .claude/settings.json Claude Code MCP registration (handles BOTH roles)"
    ;;
esac
echo -e "  scripts/              Orchestrator script + logs"
echo -e "  AGENTS.md             Role definitions (reference doc)"
echo ""

ACTIVE_STRATEGY="${STRATEGY:-architect-builder}"
echo -e "${BOLD}Configuration:${NC}"
echo -e "  Strategy:    ${CYAN}$ACTIVE_STRATEGY${NC}"
echo -e "  Engine mode: ${CYAN}$ENGINES${NC}"
echo ""

# Show role mapping based on engine mode
if [[ "$ENGINES" == "both" ]]; then
  echo -e "${BOLD}Role mapping (two-engine mode):${NC}"
  echo -e "  Cursor      → ${CYAN}Primary role${NC}"
  echo -e "  Claude Code → ${CYAN}Secondary role${NC}"
else
  echo -e "${BOLD}Role mapping (single-engine mode):${NC}"
  ENGINE_NAME="${ENGINES%-only}"
  echo -e "  ${CYAN}${ENGINE_NAME}${NC} → handles ${CYAN}BOTH Primary and Secondary${NC} roles"
  echo -e "  All tools available. Self-review enabled."
fi

echo ""
echo -e "  Change strategy:    call ${CYAN}set_strategy(\"<id>\")${NC} via MCP"
echo -e "  Change engine mode: call ${CYAN}set_engine_mode(\"<mode>\")${NC} via MCP"
echo -e "  Or re-run: ${CYAN}init.sh --strategy <id> --engines <mode>${NC}"
echo ""
echo -e "  ${BOLD}Dashboard:${NC} ${CYAN}scripts/dashboard.sh${NC}  →  http://localhost:4800"
echo ""

echo -e "${BOLD}Next steps:${NC}"
echo ""
case "$ENGINES" in
  both)
    echo -e "  ${CYAN}Step 1:${NC} Have Claude Code architect the project:"
    echo -e "         claude \"Call get_my_status from the agent-collab MCP, then create"
    echo -e "         an HLD with set_context and tasks with create_task.\""
    echo ""
    echo -e "  ${CYAN}Step 2:${NC} Open Cursor — it will call get_my_status and see its assigned tasks"
    echo ""
    echo -e "  ${CYAN}Or:${NC} Run the orchestrator for automated handoffs:"
    echo -e "         ${CYAN}scripts/orchestrate.sh --mode semi${NC}   (Claude reviews auto)"
    echo -e "         ${CYAN}scripts/orchestrate.sh --mode full${NC}   (both agents headless)"
    ;;
  cursor-only)
    echo -e "  ${CYAN}Step 1:${NC} Open Cursor — call get_my_status, create tasks, implement, self-review"
    echo -e "         You handle the full workflow: design → implement → review"
    ;;
  claude-code-only)
    echo -e "  ${CYAN}Step 1:${NC} Launch Claude Code:"
    echo -e "         claude \"Call get_my_status from the agent-collab MCP, then create"
    echo -e "         tasks, implement, and self-review.\""
    echo -e "         You handle the full workflow: design → implement → review"
    ;;
esac
echo ""
