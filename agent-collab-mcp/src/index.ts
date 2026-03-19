#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { registerStatusTools } from "./tools/status.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerContextTools } from "./tools/context.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerSetupTools, writeProjectFiles } from "./tools/setup.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerEpicTools } from "./tools/epic.js";
import { registerReservationTools } from "./tools/reservations.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { isInitialized, isHomeDir, autoSetup, getRole, getActiveStrategy, getEngineMode, getMyRoleConfig, getProjectDir } from "./db.js";

{
  let instructions: string;

  if (isHomeDir()) {
    // Global MCP running from home dir — don't create DB, just start the server.
    // Tools will return NOT_SETUP until a project is opened.
    instructions = "agent-collab MCP is running globally. Open a project folder and call setup_project to initialize.";
    process.stderr.write(`agent-collab MCP started (global mode — no project dir, tools will prompt for setup)\n`);
  } else if (!isInitialized()) {
    autoSetup();
    const mode = getEngineMode();
    writeProjectFiles(mode);
    process.stderr.write(`agent-collab MCP auto-setup complete | engine: ${mode} | strategy: architect-builder\n`);
  }

  if (!isHomeDir() && isInitialized()) {
    const strategy = getActiveStrategy();
    const engineMode = getEngineMode();
    const roleConfig = getMyRoleConfig();
    instructions = `[Strategy: ${strategy.name}] [Engine: ${engineMode}] [Role: ${roleConfig.name}] ${roleConfig.instructions}`;
  }

  const server = new McpServer({
    name: "agent-collab",
    version: "2.1.2",
  }, { instructions: instructions! });

  registerStatusTools(server);
  registerSetupTools(server);
  registerTaskTools(server);
  registerReviewTools(server);
  registerContextTools(server);
  registerStrategyTools(server);
  registerDispatchTools(server);
  registerEpicTools(server);
  registerReservationTools(server);
  registerCommentTools(server);
  registerMetricsTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (!isHomeDir() && isInitialized()) {
    const role = getRole();
    const strategy = getActiveStrategy();
    const engineMode = getEngineMode();
    const roleConfig = getMyRoleConfig();
    process.stderr.write(`agent-collab MCP started | strategy: ${strategy.name} | engine: ${engineMode} | role: ${roleConfig.name} (${role})\n`);
  }

  const dashboardScript = path.resolve(path.dirname(new URL(import.meta.url).pathname), "dashboard.js");
  if (!isHomeDir() && isInitialized() && fs.existsSync(dashboardScript)) {
    try {
      const projectDir = getProjectDir();
      const logDir = path.join(projectDir, "scripts", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "dashboard.log");
      const out = fs.openSync(logFile, "a");
      const child = spawn("node", [dashboardScript], {
        detached: true,
        stdio: ["ignore", out, out],
        cwd: projectDir,
        env: { ...process.env, PROJECT_DIR: projectDir },
      });
      child.on("error", () => {
        process.stderr.write(`Dashboard auto-start failed (non-fatal). Check scripts/logs/dashboard.log\n`);
      });
      child.unref();
      process.stderr.write(`Dashboard auto-started | http://localhost:4800 | log: scripts/logs/dashboard.log\n`);
    } catch (e) {
      process.stderr.write(`Dashboard auto-start failed: ${e instanceof Error ? e.message : e} (non-fatal)\n`);
    }
  } else {
    process.stderr.write(`Dashboard script not found at ${dashboardScript} — skipping auto-start\n`);
  }
}
