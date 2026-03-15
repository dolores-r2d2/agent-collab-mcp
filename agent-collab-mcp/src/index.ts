#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerStatusTools } from "./tools/status.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerContextTools } from "./tools/context.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerSetupTools } from "./tools/setup.js";
import { isInitialized, getRole, getActiveStrategy, getEngineMode, getMyRoleConfig } from "./db.js";

if (process.argv.includes("--dashboard")) {
  await import("./dashboard.js");
} else {
  const initialized = isInitialized();

  let instructions: string;
  if (!initialized) {
    instructions = [
      "This project hasn't been set up for agent collaboration yet.",
      "Call get_my_status to see setup instructions, or call setup_project directly.",
      "Available tools: get_my_status, setup_project, list_strategies, get_dashboard_info.",
    ].join(" ");
  } else {
    const strategy = getActiveStrategy();
    const engineMode = getEngineMode();
    const roleConfig = getMyRoleConfig();
    instructions = `[Strategy: ${strategy.name}] [Engine: ${engineMode}] [Role: ${roleConfig.name}] ${roleConfig.instructions}`;
  }

  const server = new McpServer({
    name: "agent-collab",
    version: "1.0.0",
  }, { instructions });

  registerStatusTools(server);
  registerSetupTools(server);

  if (initialized) {
    registerTaskTools(server);
    registerReviewTools(server);
    registerContextTools(server);
    registerStrategyTools(server);
  } else {
    const { getAllStrategies } = await import("./strategies.js");
    server.tool(
      "list_strategies",
      "List all available collaboration strategies.",
      {},
      async () => {
        const strategies = getAllStrategies();
        let text = "Available strategies:\n\n";
        for (const s of strategies) {
          text += `## ${s.name} (${s.id})\n`;
          text += `${s.description}\n`;
          text += `Best for: ${s.best_for}\n`;
          text += `Roles: ${s.roles.primary.name} (Primary) + ${s.roles.secondary.name} (Secondary)\n\n`;
        }
        return { content: [{ type: "text", text }] };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const role = getRole();
  if (initialized) {
    const strategy = getActiveStrategy();
    const engineMode = getEngineMode();
    const roleConfig = getMyRoleConfig();
    process.stderr.write(`agent-collab MCP started | strategy: ${strategy.name} | engine: ${engineMode} | role: ${roleConfig.name} (${role})\n`);
  } else {
    process.stderr.write(`agent-collab MCP started | NOT INITIALIZED | awaiting setup_project\n`);
  }
}
