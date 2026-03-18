import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import path from "path";
import { getDb, getRole, getActiveStrategy, getEngineMode, getMyRoleConfig, isSingleEngine } from "../db.js";
import { dispatchReview, formatResult } from "../dispatch.js";
import type { TaskRow, CountRow, ActivityRow } from "../types.js";

function checkConfigHealth(role: string, engineMode: string): string {
  if (engineMode !== "both") return "";

  const cwd = process.cwd();

  if (role === "cursor") {
    const claudeSettings = path.join(cwd, ".claude", "settings.json");
    if (!fs.existsSync(claudeSettings)) {
      return `\n⚠ MISSING CONFIG: .claude/settings.json not found. Claude Code will not have access to the agent-collab MCP.\nFix: call setup_project(strategy, "both") to re-scaffold it, or re-run init.sh.\n`;
    }
    try {
      const content = fs.readFileSync(claudeSettings, "utf-8");
      if (!content.includes("agent-collab")) {
        return `\n⚠ MISSING CONFIG: .claude/settings.json exists but does not register the agent-collab MCP server. Claude Code will not have access to the tools.\nFix: call setup_project(strategy, "both") to rewrite it, or manually add the agent-collab entry.\n`;
      }
    } catch {
      return `\n⚠ MISSING CONFIG: Could not read .claude/settings.json. Claude Code may not have access to the agent-collab MCP.\nFix: call setup_project(strategy, "both") to re-scaffold it.\n`;
    }
  }

  if (role === "claude-code") {
    const cursorMcp = path.join(cwd, ".cursor", "mcp.json");
    if (!fs.existsSync(cursorMcp)) {
      return `\n⚠ MISSING CONFIG: .cursor/mcp.json not found. Cursor will not have access to the agent-collab MCP.\nFix: call setup_project(strategy, "both") to re-scaffold it, or re-run init.sh.\n`;
    }
    try {
      const content = fs.readFileSync(cursorMcp, "utf-8");
      if (!content.includes("agent-collab")) {
        return `\n⚠ MISSING CONFIG: .cursor/mcp.json exists but does not register the agent-collab MCP server. Cursor will not have access to the tools.\nFix: call setup_project(strategy, "both") to rewrite it, or manually add the agent-collab entry.\n`;
      }
    } catch {
      return `\n⚠ MISSING CONFIG: Could not read .cursor/mcp.json. Cursor may not have access to the agent-collab MCP.\nFix: call setup_project(strategy, "both") to re-scaffold it.\n`;
    }
  }

  return "";
}

function buildToolList(access: ReturnType<typeof getMyRoleConfig>["tools"], single: boolean): string {
  const tools: string[] = [];
  if (access.task_create) tools.push("create_task");
  if (access.task_claim) tools.push("claim_task");
  if (access.task_submit) tools.push("submit_for_review");
  if (access.review_write) tools.push("review_task");
  if (access.context_write) tools.push("set_context");
  if (access.save_plan) tools.push("save_plan");
  tools.push("get_task", "get_context", "get_review_feedback", "get_project_overview", "log_activity");
  if (!single) tools.push("trigger_review", "notify_builder", "invoke_architect", "run_loop");
  tools.push("archive_epic", "list_epics", "get_epic", "get_codebase_context");
  tools.push("list_strategies", "get_active_strategy", "set_strategy", "set_engine_mode", "setup_project");
  return tools.join(", ");
}

export function registerStatusTools(server: McpServer): void {
  server.tool(
    "get_my_status",
    "Get your next action. Call this FIRST before any work.",
    {},
    async () => {
      const db = getDb();
      const role = getRole();
      const strategy = getActiveStrategy();
      const engineMode = getEngineMode();
      const roleConfig = getMyRoleConfig();
      const single = isSingleEngine();
      const access = roleConfig.tools;

      const healthWarning = checkConfigHealth(role, engineMode);
      const toolLine = `Your tools: ${buildToolList(access, single)}\n`;

      let dispatchInfo = "";
      const activeDispatches = db.prepare(
        "SELECT id, pid, role, log_file, created_at FROM dispatches WHERE status = 'running' ORDER BY id DESC"
      ).all() as { id: number; pid: number; role: string; log_file: string; created_at: string }[];
      if (activeDispatches.length > 0) {
        dispatchInfo = `\nActive dispatches (${activeDispatches.length}):\n`;
        for (const d of activeDispatches) {
          dispatchInfo += `  #${d.id} ${d.role} (PID ${d.pid}) — started ${d.created_at}\n`;
        }
      }

      const header = `${healthWarning}[Strategy: ${strategy.name}] [Engine: ${engineMode}] [Role: ${roleConfig.name}]\n${toolLine}${dispatchInfo}`;

      const inProgress = db.prepare(
        "SELECT id, title FROM tasks WHERE status = 'in-progress' ORDER BY priority DESC, id LIMIT 1"
      ).get() as TaskRow | undefined;

      if (inProgress) {
        return text(header, `RESUME: Task ${inProgress.id} "${inProgress.title}" is in-progress. Call get_task("${inProgress.id}") for details and continue working.`);
      }

      const changesReq = db.prepare(
        "SELECT id, title FROM tasks WHERE status = 'changes-requested' ORDER BY priority DESC, id LIMIT 1"
      ).get() as TaskRow | undefined;

      if (changesReq) {
        return text(header, `FIX: Task ${changesReq.id} "${changesReq.title}" has review feedback. Call claim_task("${changesReq.id}") to start fixing, then get_review_feedback("${changesReq.id}") to see the issues.`);
      }

      if (access.review_write) {
        const reviewTasks = db.prepare(
          "SELECT id, title FROM tasks WHERE status = 'review' ORDER BY priority DESC, id"
        ).all() as TaskRow[];
        if (reviewTasks.length > 0) {
          const list = reviewTasks.map(t => `  - ${t.id}: ${t.title}`).join("\n");
          const intro = single
            ? "Self-review time"
            : "Tasks awaiting your review";
          return text(header, `REVIEW: ${intro} — ${reviewTasks.length} task(s):\n${list}\n\nCall get_task("<id>") to read details, then review_task("<id>", ...) for each.`);
        }
      }

      const assigned = db.prepare(
        "SELECT id, title FROM tasks WHERE status = 'assigned' ORDER BY priority DESC, id LIMIT 1"
      ).get() as TaskRow | undefined;

      if (assigned) {
        if (access.task_claim) {
          return text(header, `NEXT: Task ${assigned.id} "${assigned.title}" is ready. Call claim_task("${assigned.id}") to start working on it.`);
        }
        return text(header, `WAITING: Task ${assigned.id} is assigned but not to your role. ` +
          (single ? "Check engine mode configuration." : "The other agent needs to claim it."));
      }

      const reviewTasks = db.prepare(
        "SELECT id FROM tasks WHERE status = 'review' ORDER BY id"
      ).all() as TaskRow[];

      if (reviewTasks.length > 0 && !access.review_write) {
        if (single) {
          return text(header, `${reviewTasks.length} task(s) are in review. You have all tools — call review_task to review them.`);
        }
        const taskIds = reviewTasks.map(t => t.id);
        const result = dispatchReview(taskIds);
        return text(header, `${reviewTasks.length} task(s) pending review. Auto-dispatching batch reviewer: ${formatResult(result)}\nCall get_my_status again later to check progress.`);
      }

      const totalTasks = (db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE status != 'cancelled'"
      ).get() as { cnt: number }).cnt;

      if (totalTasks === 0) {
        const epicCount = (db.prepare("SELECT COUNT(*) as cnt FROM epics").get() as { cnt: number }).cnt;
        const historyHint = epicCount > 0
          ? ` This project has ${epicCount} archived epic(s) — call get_codebase_context() to see past work before starting.`
          : "";

        if (access.task_create) {
          return text(header, `No tasks on the board.${historyHint} Create an HLD with set_context("hld", ...) and then create tasks with create_task(...). Set notify_builder=true on the last create_task to auto-invoke the builder.`);
        }
        if (single) {
          return text(header, `No tasks on the board.${historyHint} You have all tools — start by creating tasks with create_task(...).`);
        }
        return text(header, `No tasks exist.${historyHint} Call invoke_architect("describe what the user wants built") to have Claude Code create the HLD and tasks. Pass the user's original request as the argument.`);
      }

      return text(header, "All tasks are done. Consider archiving this work with archive_epic(\"<name>\") to clear the board for the next feature. Or create new tasks if there are more requirements.");
    }
  );

  server.tool(
    "get_project_overview",
    "Get a high-level project status summary.",
    {},
    async () => {
      const db = getDb();
      const strategy = getActiveStrategy();
      const engineMode = getEngineMode();
      const counts = db.prepare(
        "SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"
      ).all() as CountRow[];

      const total = counts.reduce((s, r) => s + r.cnt, 0);

      const recent = db.prepare(
        "SELECT timestamp, agent, action FROM activity_log ORDER BY id DESC LIMIT 5"
      ).all() as ActivityRow[];

      const epicCount = (db.prepare("SELECT COUNT(*) as cnt FROM epics").get() as { cnt: number }).cnt;

      let out = `Strategy: ${strategy.name} | Engine mode: ${engineMode}\n`;
      out += `Project: ${total} tasks total | ${epicCount} archived epic(s)\n`;
      for (const r of counts) {
        out += `  ${r.status}: ${r.cnt}\n`;
      }

      if (recent.length > 0) {
        out += "\nRecent activity:\n";
        for (const r of recent) {
          out += `  [${r.timestamp}] ${r.agent}: ${r.action}\n`;
        }
      }

      return { content: [{ type: "text" as const, text: out }] };
    }
  );
}

function text(header: string, body: string) {
  return { content: [{ type: "text" as const, text: header + body }] };
}
