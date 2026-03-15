import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { getDb, setActiveStrategy, setEngineMode, getRole } from "../db.js";
import { getStrategyDef, getAllStrategies, getDefaultStrategyId, type EngineMode } from "../strategies.js";
import { getCursorTemplates, getClaudeTemplates, type TemplateFile } from "../templates.js";

export function registerSetupTools(server: McpServer): void {
  const role = getRole();

  server.tool(
    "setup_project",
    "Initialize agent collaboration for this project. Creates the database, config files, hooks, and rules.",
    {
      strategy: z.string().optional().describe("Strategy ID (default: architect-builder). Call list_strategies to see options."),
      engine_mode: z.enum(["both", "cursor-only", "claude-code-only"]).describe("REQUIRED. Engine mode: 'both' (Cursor builds, Claude Code reviews), 'cursor-only' (Cursor does everything), or 'claude-code-only'."),
      project_name: z.string().optional().describe("Project name (default: current directory name)"),
    },
    async ({ strategy, engine_mode, project_name }) => {
      const strategyId = strategy || getDefaultStrategyId();
      const mode = engine_mode;
      const projName = project_name || path.basename(process.cwd());

      const def = getStrategyDef(strategyId);
      if (!def) {
        const ids = getAllStrategies().map(s => s.id).join(", ");
        return { content: [{ type: "text", text: `Unknown strategy "${strategyId}". Available: ${ids}` }] };
      }

      const db = getDb();

      setActiveStrategy(db, strategyId);
      setEngineMode(db, mode as EngineMode);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Project setup: strategy=${strategyId}, engine=${mode}, name=${projName}`);

      const written: string[] = [];
      const skipped: string[] = [];

      const templates: TemplateFile[] = [...getCursorTemplates()];
      if (mode === "both" || mode === "claude-code-only") {
        templates.push(...getClaudeTemplates());
      }

      for (const tmpl of templates) {
        const dest = path.join(process.cwd(), tmpl.path);
        if (fs.existsSync(dest)) {
          skipped.push(tmpl.path);
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, tmpl.content, "utf-8");
        if (tmpl.executable) {
          fs.chmodSync(dest, 0o755);
        }
        written.push(tmpl.path);
      }

      const gitignore = path.join(process.cwd(), ".gitignore");
      const ignoreEntries = [".agent-collab/", "scripts/logs/"];
      if (fs.existsSync(gitignore)) {
        const content = fs.readFileSync(gitignore, "utf-8");
        const toAdd = ignoreEntries.filter(e => !content.includes(e));
        if (toAdd.length > 0) {
          fs.appendFileSync(gitignore, "\n" + toAdd.join("\n") + "\n");
          written.push(".gitignore (updated)");
        }
      }

      fs.mkdirSync(path.join(process.cwd(), "scripts/logs"), { recursive: true });

      let text = `Project "${projName}" configured!\n\n`;
      text += `Strategy: ${def.name} (${strategyId})\n`;
      text += `Engine mode: ${mode}\n\n`;

      if (written.length > 0) {
        text += `Created ${written.length} file(s):\n`;
        for (const f of written) text += `  + ${f}\n`;
      }
      if (skipped.length > 0) {
        text += `\nSkipped ${skipped.length} existing file(s):\n`;
        for (const f of skipped) text += `  ~ ${f}\n`;
      }

      text += `\nDatabase: .agent-collab/collab.db\n`;
      text += `\nThe project is ready. Tell the user:\n`;
      text += `  - To see the live dashboard: scripts/dashboard.sh → http://localhost:4800\n`;
      text += `  - Call get_my_status to see your first action\n`;

      if (mode === "cursor-only") {
        text += `\nYou handle both roles (${def.roles.primary.name} + ${def.roles.secondary.name}). Start by creating an HLD and tasks.\n`;
      } else if (mode === "both") {
        text += `\nCursor = ${def.roles.primary.name} (Primary), Claude Code = ${def.roles.secondary.name} (Secondary)\n`;
      }

      text += `\nIMPORTANT: The MCP server needs to restart to pick up the new config. Ask the user to reload the Cursor window (Cmd+Shift+P → "Developer: Reload Window").`;

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_dashboard_info",
    "Get the command to launch the collaboration dashboard.",
    {},
    async () => {
      const dashScript = path.join(process.cwd(), "scripts/dashboard.sh");
      const hasDashScript = fs.existsSync(dashScript);

      let text = "Dashboard — real-time web UI for task tracking\n\n";
      if (hasDashScript) {
        text += "Launch:  scripts/dashboard.sh\n";
      } else {
        text += "Launch:  npx -y agent-collab-mcp -- --dashboard\n";
      }
      text += "URL:     http://localhost:4800\n";
      text += "Custom:  scripts/dashboard.sh --port 5000\n";

      return { content: [{ type: "text", text }] };
    }
  );
}
