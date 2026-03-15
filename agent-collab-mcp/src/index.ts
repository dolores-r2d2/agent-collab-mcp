#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerStatusTools } from "./tools/status.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerContextTools } from "./tools/context.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerSetupTools } from "./tools/setup.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerEpicTools } from "./tools/epic.js";
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
      "All tools are visible but most require setup first.",
    ].join(" ");
  } else {
    const strategy = getActiveStrategy();
    const engineMode = getEngineMode();
    const roleConfig = getMyRoleConfig();
    instructions = `[Strategy: ${strategy.name}] [Engine: ${engineMode}] [Role: ${roleConfig.name}] ${roleConfig.instructions}`;
  }

  const server = new McpServer({
    name: "agent-collab",
    version: "1.3.0",
  }, { instructions });

  registerStatusTools(server);
  registerSetupTools(server);
  registerTaskTools(server);
  registerReviewTools(server);
  registerContextTools(server);
  registerStrategyTools(server);
  registerDispatchTools(server);
  registerEpicTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const role = getRole();
  if (initialized) {
    const strategy = getActiveStrategy();
    const engineMode = getEngineMode();
    const roleConfig = getMyRoleConfig();
    process.stderr.write(`agent-collab MCP started | strategy: ${strategy.name} | engine: ${engineMode} | role: ${roleConfig.name} (${role})\n`);
  } else {
    process.stderr.write(`agent-collab MCP started | NOT INITIALIZED | all tools visible, awaiting setup_project\n`);
  }
}
