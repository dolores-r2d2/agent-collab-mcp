#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerStatusTools } from "./tools/status.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerContextTools } from "./tools/context.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerSetupTools, writeProjectFiles } from "./tools/setup.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerEpicTools } from "./tools/epic.js";
import { isInitialized, autoSetup, getRole, getActiveStrategy, getEngineMode, getMyRoleConfig } from "./db.js";

if (process.argv.includes("--dashboard")) {
  await import("./dashboard.js");
} else {
  if (!isInitialized()) {
    autoSetup();
    const mode = getEngineMode();
    writeProjectFiles(mode);
    process.stderr.write(`agent-collab MCP auto-setup complete | engine: ${mode} | strategy: architect-builder\n`);
  }

  const strategy = getActiveStrategy();
  const engineMode = getEngineMode();
  const roleConfig = getMyRoleConfig();
  const instructions = `[Strategy: ${strategy.name}] [Engine: ${engineMode}] [Role: ${roleConfig.name}] ${roleConfig.instructions}`;

  const server = new McpServer({
    name: "agent-collab",
    version: "1.4.0",
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
  process.stderr.write(`agent-collab MCP started | strategy: ${strategy.name} | engine: ${engineMode} | role: ${roleConfig.name} (${role})\n`);
}
