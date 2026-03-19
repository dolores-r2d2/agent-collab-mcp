import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { getDb, setActiveStrategy, setEngineMode, getRole, getProjectDir, setProjectDir, isHomeDir } from "../db.js";
import { getStrategyDef, getAllStrategies, getDefaultStrategyId, type EngineMode } from "../strategies.js";
import { getCursorTemplates, getClaudeTemplates, type TemplateFile } from "../templates.js";

export interface WriteResult {
  written: string[];
  skipped: string[];
}

const MCP_CONFIG_PATHS = new Set([".cursor/mcp.json", ".claude/settings.json"]);

function isMcpConfig(tmplPath: string): boolean {
  return MCP_CONFIG_PATHS.has(tmplPath);
}

function mergeAgentCollabInto(existingPath: string, templateContent: string): boolean {
  try {
    const existing = JSON.parse(fs.readFileSync(existingPath, "utf-8"));
    const template = JSON.parse(templateContent);
    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers["agent-collab"] = template.mcpServers["agent-collab"];
    fs.writeFileSync(existingPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function writeProjectFiles(mode: string): WriteResult {
  const written: string[] = [];
  const skipped: string[] = [];

  const templates: TemplateFile[] = [...getCursorTemplates()];
  if (mode === "both" || mode === "claude-code-only") {
    templates.push(...getClaudeTemplates());
  }

  for (const tmpl of templates) {
    const dest = path.join(getProjectDir(), tmpl.path);
    if (fs.existsSync(dest)) {
      if (isMcpConfig(tmpl.path)) {
        const content = fs.readFileSync(dest, "utf-8");
        if (!content.includes("agent-collab")) {
          if (mergeAgentCollabInto(dest, tmpl.content)) {
            written.push(`${tmpl.path} (merged agent-collab entry)`);
          } else {
            skipped.push(`${tmpl.path} (merge failed)`);
          }
        } else {
          skipped.push(tmpl.path);
        }
      } else {
        skipped.push(tmpl.path);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, tmpl.content, "utf-8");
    if (tmpl.executable) {
      fs.chmodSync(dest, 0o755);
    }
    written.push(tmpl.path);
  }

  const gitignore = path.join(getProjectDir(), ".gitignore");
  const ignoreEntries = [".agent-collab/", "scripts/logs/"];
  if (fs.existsSync(gitignore)) {
    const content = fs.readFileSync(gitignore, "utf-8");
    const toAdd = ignoreEntries.filter(e => !content.includes(e));
    if (toAdd.length > 0) {
      fs.appendFileSync(gitignore, "\n" + toAdd.join("\n") + "\n");
      written.push(".gitignore (updated)");
    }
  }

  fs.mkdirSync(path.join(getProjectDir(), "scripts/logs"), { recursive: true });

  return { written, skipped };
}

export function registerSetupTools(server: McpServer): void {
  const role = getRole();

  server.tool(
    "setup_project",
    "Set up or reconfigure agent collaboration. Use engine_mode='both' for Cursor+Claude Code collaboration. Pass project_dir if running as a global MCP.",
    {
      engine_mode: z.enum(["both", "cursor-only", "claude-code-only"]).default("both").describe("Engine mode. Defaults to 'both' (Cursor builds, Claude Code reviews). Do NOT change this unless the user explicitly asks for single-engine mode."),
      strategy: z.string().optional().describe("Strategy ID (default: architect-builder). Call list_strategies to see options."),
      project_name: z.string().optional().describe("Project name (default: current directory name)"),
      project_dir: z.string().optional().describe("Absolute path to the project directory. Required when running as a global MCP without a project-specific config."),
    },
    async ({ engine_mode, strategy, project_name, project_dir }) => {
      // If project_dir provided, override for this session
      if (project_dir) {
        if (!fs.existsSync(project_dir)) {
          return { content: [{ type: "text", text: `Directory not found: ${project_dir}` }] };
        }
        setProjectDir(project_dir);
      } else if (isHomeDir()) {
        return { content: [{ type: "text", text: `Cannot set up in home directory. Pass project_dir="/path/to/your/project" to specify the project location.` }] };
      }

      const strategyId = strategy || getDefaultStrategyId();
      const mode = engine_mode;
      const projName = project_name || path.basename(getProjectDir());

      const def = getStrategyDef(strategyId);
      if (!def) {
        const ids = getAllStrategies().map(s => s.id).join(", ");
        return { content: [{ type: "text", text: `Unknown strategy "${strategyId}". Available: ${ids}` }] };
      }

      const db = getDb();

      // Warn if switching modes with open tasks owned by the engine being removed
      const currentMode = db.prepare("SELECT value FROM config WHERE key = 'engine_mode'").get() as { value: string } | undefined;
      let modeWarning = "";
      if (currentMode?.value === "both" && mode !== "both") {
        const removedEngine = mode === "cursor-only" ? "claude-code" : "cursor";
        const orphanedTasks = db.prepare(
          "SELECT id, title, status FROM tasks WHERE owner = ? AND status NOT IN ('done', 'cancelled')"
        ).all(removedEngine) as { id: string; title: string; status: string }[];
        if (orphanedTasks.length > 0) {
          modeWarning = `\n⚠ WARNING: ${orphanedTasks.length} open task(s) owned by "${removedEngine}" will be orphaned:\n`;
          for (const t of orphanedTasks) {
            modeWarning += `  ${t.id}: "${t.title}" (${t.status})\n`;
          }
          modeWarning += `Consider reassigning these tasks or completing them before switching modes.\n`;
        }
      }

      setActiveStrategy(db, strategyId);
      setEngineMode(db, mode as EngineMode);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Project setup: strategy=${strategyId}, engine=${mode}, name=${projName}`);

      const { written, skipped } = writeProjectFiles(mode);

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

      if (mode === "cursor-only") {
        text += `\nYou handle both roles (${def.roles.primary.name} + ${def.roles.secondary.name}). Start by creating an HLD and tasks.\n`;
      } else if (mode === "both") {
        text += `\nCursor = ${def.roles.primary.name} (Primary), Claude Code = ${def.roles.secondary.name} (Secondary)\n`;
      }

      text += modeWarning;
      text += `\nCall get_my_status to see your next action.`;

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_dashboard_info",
    "Get the command to launch the collaboration dashboard.",
    {},
    async () => {
      const dashScript = path.join(getProjectDir(), "scripts/dashboard.sh");
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
