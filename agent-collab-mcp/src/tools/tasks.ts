import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole, getToolAccess, getDefaultOwner, nextTaskId, isSingleEngine } from "../db.js";
import { dispatchBuilder, formatResult } from "../dispatch.js";

const NOT_SETUP = { content: [{ type: "text" as const, text: "Project not set up. Call setup_project first." }] };
const NO_ACCESS = (tool: string) => ({ content: [{ type: "text" as const, text: `${tool} is not available for your current role. Call get_my_status to see your available tools.` }] });

interface TaskRow {
  id: string;
  title: string;
  status: string;
  owner: string;
  depends_on: string | null;
  context: string | null;
  acceptance: string | null;
  plan: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewRow {
  round: number;
  verdict: string;
  issues: string | null;
  notes: string | null;
  created_at: string;
}

export function registerTaskTools(server: McpServer): void {
  server.tool(
    "get_task",
    "Get full details for a task including latest review.",
    { task_id: z.string().describe("Task ID, e.g. T-001") },
    async ({ task_id }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as TaskRow | undefined;

      if (!task) {
        return { content: [{ type: "text", text: `Task ${task_id} not found.` }] };
      }

      const latestReview = db.prepare(
        "SELECT round, verdict, issues, notes, created_at FROM reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1"
      ).get(task_id) as ReviewRow | undefined;

      let text = `Task: ${task.id} — ${task.title}\n`;
      text += `Status: ${task.status} | Owner: ${task.owner}\n`;
      if (task.depends_on) text += `Depends on: ${task.depends_on}\n`;
      text += `\nContext:\n${task.context || "(none)"}\n`;
      text += `\nAcceptance:\n${task.acceptance || "(none)"}\n`;
      if (task.plan) text += `\nPlan:\n${task.plan}\n`;

      if (latestReview) {
        text += `\nLatest review (round ${latestReview.round}): ${latestReview.verdict}\n`;
        if (latestReview.issues) {
          try {
            const issues = JSON.parse(latestReview.issues);
            for (const issue of issues) {
              text += `  - [${issue.file || "general"}${issue.line ? ":" + issue.line : ""}] ${issue.description}\n`;
            }
          } catch {
            text += `  Issues: ${latestReview.issues}\n`;
          }
        }
        if (latestReview.notes) text += `  Notes: ${latestReview.notes}\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "create_task",
    "Create a new task. Owner defaults based on engine mode.",
    {
      title: z.string().describe("Short task title"),
      context: z.string().describe("2-3 lines of context from HLD"),
      acceptance: z.string().describe("Criteria that define done"),
      depends_on: z.string().optional().describe("Comma-separated task IDs this depends on"),
      owner: z.enum(["cursor", "claude-code"]).optional().describe("Task owner (defaults based on engine mode)"),
      notify_builder: z.boolean().optional().describe("If true, auto-invoke the builder agent to start working. Use on the last task in a batch."),
    },
    async ({ title, context, acceptance, depends_on, owner, notify_builder: shouldNotify }) => {
      if (!isInitialized()) return NOT_SETUP;
      if (!getToolAccess().task_create) return NO_ACCESS("create_task");

      const db = getDb();
      const role = getRole();
      const id = nextTaskId(db);
      const taskOwner = owner || getDefaultOwner();

      db.prepare(`
        INSERT INTO tasks (id, title, status, owner, depends_on, context, acceptance)
        VALUES (?, ?, 'assigned', ?, ?, ?, ?)
      `).run(id, title, taskOwner, depends_on || null, context, acceptance);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Created task ${id}: ${title} (owner: ${taskOwner})`);

      let text = `Created ${id}: "${title}" (assigned to ${taskOwner}).`;

      if (shouldNotify && !isSingleEngine()) {
        const assigned = db.prepare("SELECT id FROM tasks WHERE status = 'assigned' ORDER BY id").all() as { id: string }[];
        const result = dispatchBuilder(assigned.map(t => t.id), `${assigned.length} task(s) are ready for you.`);
        text += `\nBuilder notification: ${formatResult(result)}`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "claim_task",
    "Claim a task and set it to in-progress. Works on 'assigned' or 'changes-requested' tasks.",
    { task_id: z.string().describe("Task ID to claim, e.g. T-001") },
    async ({ task_id }) => {
      if (!isInitialized()) return NOT_SETUP;
      if (!getToolAccess().task_claim) return NO_ACCESS("claim_task");

      const db = getDb();
      const role = getRole();
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as TaskRow | undefined;

      if (!task) {
        return { content: [{ type: "text", text: `Task ${task_id} not found.` }] };
      }

      if (task.status !== "assigned" && task.status !== "changes-requested") {
        return {
          content: [{
            type: "text",
            text: `Cannot claim ${task_id}: status is "${task.status}". Only "assigned" or "changes-requested" tasks can be claimed.`
          }]
        };
      }

      db.prepare(
        "UPDATE tasks SET status = 'in-progress', updated_at = datetime('now') WHERE id = ?"
      ).run(task_id);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Claimed task ${task_id}`);

      let text = `Claimed ${task_id}: "${task.title}" — now in-progress.\n\nContext:\n${task.context || "(none)"}\n\nAcceptance:\n${task.acceptance || "(none)"}`;

      if (task.status === "changes-requested") {
        const review = db.prepare(
          "SELECT issues, notes FROM reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1"
        ).get(task_id) as ReviewRow | undefined;

        if (review?.issues) {
          text += "\n\nReview issues to fix:\n";
          try {
            const issues = JSON.parse(review.issues);
            for (const issue of issues) {
              text += `  - [${issue.file || "general"}${issue.line ? ":" + issue.line : ""}] ${issue.description}\n`;
            }
          } catch {
            text += `  ${review.issues}\n`;
          }
        }
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "save_plan",
    "Save your implementation plan for a task.",
    {
      task_id: z.string().describe("Task ID"),
      plan: z.string().describe("Your implementation plan"),
    },
    async ({ task_id, plan }) => {
      if (!isInitialized()) return NOT_SETUP;
      if (!getToolAccess().save_plan) return NO_ACCESS("save_plan");

      const db = getDb();
      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task_id) as TaskRow | undefined;

      if (!task) {
        return { content: [{ type: "text", text: `Task ${task_id} not found.` }] };
      }

      db.prepare(
        "UPDATE tasks SET plan = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(plan, task_id);

      return { content: [{ type: "text", text: `Plan saved for ${task_id}. Proceed with implementation.` }] };
    }
  );

  server.tool(
    "submit_for_review",
    "Mark a task as complete and submit for review.",
    {
      task_id: z.string().describe("Task ID"),
      summary: z.string().describe("1-3 line summary of what was done"),
    },
    async ({ task_id, summary }) => {
      if (!isInitialized()) return NOT_SETUP;
      if (!getToolAccess().task_submit) return NO_ACCESS("submit_for_review");

      const db = getDb();
      const role = getRole();
      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task_id) as TaskRow | undefined;

      if (!task) {
        return { content: [{ type: "text", text: `Task ${task_id} not found.` }] };
      }

      if (task.status !== "in-progress") {
        return {
          content: [{
            type: "text",
            text: `Cannot submit ${task_id}: status is "${task.status}". Only "in-progress" tasks can be submitted.`
          }]
        };
      }

      db.prepare(
        "UPDATE tasks SET status = 'review', summary = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(summary, task_id);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Submitted ${task_id} for review: ${summary}`);

      let text = `${task_id} submitted for review.`;

      if (!isSingleEngine()) {
        text += ` Submit more tasks or call trigger_review() when ready for batch review.`;
      }

      text += ` Call get_my_status to see your next action.`;

      return { content: [{ type: "text", text }] };
    }
  );
}
