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
              "If they just say 'go with defaults' or similar, use architect-builder + cursor-only.",
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

      const header = `[Strategy: ${strategy.name}] [Engine: ${engineMode}] [Role: ${roleConfig.name}]\n`;

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
        return text(header, `WAIT: ${reviewCount} task(s) are pending review by the other agent. Do NOT start new work until reviews complete.`);
      }

      const totalTasks = (db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks"
      ).get() as { cnt: number }).cnt;

      if (totalTasks === 0) {
        if (access.task_create) {
          return text(header, `No tasks exist yet. Create an HLD with set_context("hld", ...) and then create tasks with create_task(...).`);
        }
        if (single) {
          return text(header, `No tasks exist yet. You have all tools — start by creating tasks with create_task(...).`);
        }
        return text(header, `STOP: No tasks exist. Do NOT write code directly. The other agent must create tasks first.`);
      }

      return text(header, "All tasks are done. No work remaining. Create new tasks if there are new requirements.");
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

      let out = `Strategy: ${strategy.name} | Engine mode: ${engineMode}\n`;
      out += `Project: ${total} tasks total\n`;
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
