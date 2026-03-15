import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitialized, getDb, getRole, getActiveStrategy, getEngineMode, getMyRoleConfig, isSingleEngine } from "../db.js";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  owner: string;
}

interface CountRow {
  status: string;
  cnt: number;
}

interface ActivityRow {
  timestamp: string;
  agent: string;
  action: string;
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
  if (!single) tools.push("trigger_review", "notify_builder", "run_loop");
  tools.push("archive_epic", "list_epics", "get_epic", "get_codebase_context");
  tools.push("list_strategies", "get_active_strategy", "set_strategy", "set_engine_mode");
  return tools.join(", ");
}

export function registerStatusTools(server: McpServer): void {
  server.tool(
    "get_my_status",
    "Get your next action. Call this FIRST before any work.",
    {},
    async () => {
      if (!isInitialized()) {
        return {
          content: [{
            type: "text",
            text: [
              "SETUP_NEEDED: This project hasn't been configured for agent collaboration yet.\n",
              "Ask the user which setup they'd like:\n",
              "1. Strategy (default: architect-builder):",
              "   - architect-builder — One designs, the other builds",
              "   - tdd-red-green — One writes tests, the other makes them pass",
              "   - writer-reviewer — One writes code, the other critiques",
              "   - parallel-specialist — Domain split, cross-review",
              "   - planner-executor — Detailed specs, mechanical execution",
              "   - sequential-pipeline — Multi-stage quality review\n",
              "2. Engine mode (default: cursor-only):",
              "   - cursor-only: You handle everything (design + implement + review)",
              "   - both: Cursor implements, Claude Code reviews",
              "   - claude-code-only: Claude Code handles everything\n",
              "After getting their choices, call setup_project(strategy, engine_mode).",
              "If they just say 'go with defaults' or similar, use architect-builder + cursor-only.\n",
              "Available tools before setup: get_my_status, setup_project, list_strategies, get_dashboard_info",
            ].join("\n"),
          }],
        };
      }

      const db = getDb();
      const strategy = getActiveStrategy();
      const engineMode = getEngineMode();
      const roleConfig = getMyRoleConfig();
      const single = isSingleEngine();
      const access = roleConfig.tools;

      const toolLine = `Your tools: ${buildToolList(access, single)}\n`;
      const header = `[Strategy: ${strategy.name}] [Engine: ${engineMode}] [Role: ${roleConfig.name}]\n${toolLine}`;

      const inProgress = db.prepare(
        "SELECT id, title FROM tasks WHERE status = 'in-progress' LIMIT 1"
      ).get() as TaskRow | undefined;

      if (inProgress) {
        return text(header, `RESUME: Task ${inProgress.id} "${inProgress.title}" is in-progress. Call get_task("${inProgress.id}") for details and continue working.`);
      }

      const changesReq = db.prepare(
        "SELECT id, title FROM tasks WHERE status = 'changes-requested' LIMIT 1"
      ).get() as TaskRow | undefined;

      if (changesReq) {
        return text(header, `FIX: Task ${changesReq.id} "${changesReq.title}" has review feedback. Call claim_task("${changesReq.id}") to start fixing, then get_review_feedback("${changesReq.id}") to see the issues.`);
      }

      if (access.review_write) {
        const reviewTasks = db.prepare(
          "SELECT id, title FROM tasks WHERE status = 'review' ORDER BY id"
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
        "SELECT id, title FROM tasks WHERE status = 'assigned' ORDER BY id LIMIT 1"
      ).get() as TaskRow | undefined;

      if (assigned) {
        if (access.task_claim) {
          return text(header, `NEXT: Task ${assigned.id} "${assigned.title}" is ready. Call claim_task("${assigned.id}") to start working on it.`);
        }
        return text(header, `WAITING: Task ${assigned.id} is assigned but not to your role. ` +
          (single ? "Check engine mode configuration." : "The other agent needs to claim it."));
      }

      const reviewCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'review'"
      ).get() as { cnt: number }).cnt;

      if (reviewCount > 0 && !access.review_write) {
        if (single) {
          return text(header, `${reviewCount} task(s) are in review. You have all tools — call review_task to review them.`);
        }
        return text(header, `WAIT: ${reviewCount} task(s) are pending review by the other agent. The reviewer was auto-invoked when you submitted. If it hasn't started, call trigger_review() to dispatch it manually.`);
      }

      const totalTasks = (db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks"
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
        return text(header, `STOP: No tasks exist.${historyHint} Do NOT write code directly. The architect agent must create tasks first.`);
      }

      return text(header, "All tasks are done. Consider archiving this work with archive_epic(\"<name>\") to clear the board for the next feature. Or create new tasks if there are more requirements.");
    }
  );

  server.tool(
    "get_project_overview",
    "Get a high-level project status summary.",
    {},
    async () => {
      if (!isInitialized()) {
        return { content: [{ type: "text", text: "Project not initialized. Call setup_project first." }] };
      }

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
