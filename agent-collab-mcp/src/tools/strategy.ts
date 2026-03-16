import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole, getActiveStrategy, getEngineMode, getMyRoleConfig, setActiveStrategy, setEngineMode, isSingleEngine } from "../db.js";
import { getAllStrategies, getStrategyDef, type EngineMode } from "../strategies.js";
import { NOT_SETUP, err } from "../errors.js";

export function registerStrategyTools(server: McpServer): void {
  server.tool(
    "list_strategies",
    "List all available collaboration strategies with descriptions.",
    {},
    async () => {
      const strategies = getAllStrategies();

      if (!isInitialized()) {
        let text = "Available strategies:\n\n";
        for (const s of strategies) {
          text += `## ${s.name} (${s.id})\n`;
          text += `${s.description}\n`;
          text += `Best for: ${s.best_for}\n`;
          text += `Roles: ${s.roles.primary.name} (Primary) + ${s.roles.secondary.name} (Secondary)\n\n`;
        }
        return { content: [{ type: "text", text }] };
      }

      const active = getActiveStrategy();
      const mode = getEngineMode();

      let text = `Active strategy: ${active.id} — ${active.name}\n`;
      text += `Engine mode: ${mode}\n\n`;
      text += "Available strategies:\n\n";

      for (const s of strategies) {
        const marker = s.id === active.id ? " [active]" : "";
        text += `## ${s.name} (${s.id})${marker}\n`;
        text += `${s.description}\n`;
        text += `Best for: ${s.best_for}\n`;
        text += `Roles:\n`;
        text += `  Primary → ${s.roles.primary.name}: ${s.roles.primary.description}\n`;
        text += `  Secondary → ${s.roles.secondary.name}: ${s.roles.secondary.description}\n`;

        if (mode === "both") {
          text += `  Mapping: cursor → Primary, claude-code → Secondary\n`;
        } else {
          text += `  Mapping: ${mode} — single agent handles both roles\n`;
        }
        text += "\n";
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_active_strategy",
    "Get the current collaboration strategy, engine mode, and your role.",
    {},
    async () => {
      if (!isInitialized()) return NOT_SETUP;

      const strategy = getActiveStrategy();
      const mode = getEngineMode();
      const roleConfig = getMyRoleConfig();

      let text = `Strategy: ${strategy.name} (${strategy.id})\n`;
      text += `Engine mode: ${mode}\n`;
      text += `${strategy.description}\n\n`;
      text += `Your role: ${roleConfig.name}\n`;
      text += `${roleConfig.description}\n\n`;
      text += `Your workflow:\n${roleConfig.instructions}\n`;

      if (mode === "both") {
        text += `\nRole mapping:\n`;
        text += `  cursor → ${strategy.roles.primary.name} (Primary)\n`;
        text += `  claude-code → ${strategy.roles.secondary.name} (Secondary)\n`;
      } else {
        text += `\nSingle-engine mode: you handle both Primary (${strategy.roles.primary.name}) and Secondary (${strategy.roles.secondary.name}) roles.\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "set_strategy",
    "Change the collaboration strategy. Affects how agents work together.",
    {
      strategy_id: z.string().describe("Strategy ID from list_strategies"),
      confirm: z.boolean().describe("Set to true to confirm the change"),
    },
    async ({ strategy_id, confirm }) => {
      if (!isInitialized()) return NOT_SETUP;
      const role = getRole();
      const canChange = role === "claude-code" || isSingleEngine() || role === "unknown";
      if (!canChange) {
        return { content: [{ type: "text", text: "set_strategy is only available to the secondary role or in single-engine mode." }] };
      }

      const def = getStrategyDef(strategy_id);
      if (!def) {
        const ids = getAllStrategies().map(s => s.id).join(", ");
        return { content: [{ type: "text", text: `Unknown strategy "${strategy_id}". Available: ${ids}` }] };
      }

      if (!confirm) {
        let text = `About to switch to: ${def.name}\n\n`;
        text += `${def.description}\n\n`;
        text += `Primary role: ${def.roles.primary.name}\n`;
        text += `Secondary role: ${def.roles.secondary.name}\n\n`;
        text += `Call set_strategy("${strategy_id}", confirm=true) to apply.\n`;
        text += `NOTE: Agents need to restart their MCP connections to pick up the new roles.`;
        return { content: [{ type: "text", text }] };
      }

      const db = getDb();
      setActiveStrategy(db, strategy_id);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Changed strategy to: ${def.name} (${strategy_id})`);

      return {
        content: [{
          type: "text",
          text: `Strategy changed to: ${def.name} (${strategy_id}). Restart MCP connections to apply.`
        }]
      };
    }
  );

  server.tool(
    "set_engine_mode",
    "Change which engines are active: 'both', 'cursor-only', or 'claude-code-only'.",
    {
      mode: z.enum(["both", "cursor-only", "claude-code-only"]).describe("Engine mode"),
      confirm: z.boolean().describe("Set to true to confirm"),
    },
    async ({ mode, confirm }) => {
      if (!isInitialized()) return NOT_SETUP;
      const role = getRole();
      const canChange = role === "claude-code" || isSingleEngine() || role === "unknown";
      if (!canChange) {
        return { content: [{ type: "text", text: "set_engine_mode is only available to the secondary role or in single-engine mode." }] };
      }

      const current = getEngineMode();

      if (!confirm) {
        let text = `Current engine mode: ${current}\n`;
        text += `Switching to: ${mode}\n\n`;
        if (mode === "both") {
          text += "Both engines active: cursor → Primary role, claude-code → Secondary role.\n";
          text += "Each engine sees only its role's tools.\n";
        } else {
          text += `Single engine (${mode}): one agent handles BOTH Primary and Secondary roles.\n`;
          text += "All tools are available. Self-review is used.\n";
        }
        text += `\nCall set_engine_mode("${mode}", confirm=true) to apply.`;
        return { content: [{ type: "text", text }] };
      }

      const db = getDb();
      setEngineMode(db, mode as EngineMode);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Changed engine mode to: ${mode}`);

      let text = `Engine mode changed to: ${mode}.\n`;
      if (mode === "both") {
        text += "Update .cursor/mcp.json (AGENT_ROLE=cursor) and .claude/settings.json (AGENT_ROLE=claude-code).\n";
      } else {
        text += `Only the ${mode.replace("-only", "")} config file is needed.\n`;
      }
      text += "Restart MCP connections to apply.";

      return { content: [{ type: "text", text }] };
    }
  );
}
