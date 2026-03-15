import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, getRole, getToolAccess, getDefaultOwner, nextTaskId } from "../db.js";

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
  const access = getToolAccess();
  const role = getRole();

  server.tool(
    "get_task",
    "Get full details for a task including latest review.",
    { task_id: z.string().describe("Task ID, e.g. T-001") },
    async ({ task_id }) => {
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

  if (access.task_create) {
    server.tool(
      "create_task",
      "Create a new task. Owner defaults based on engine mode.",
      {
        title: z.string().describe("Short task title"),
        context: z.string().describe("2-3 lines of context from HLD"),
        acceptance: z.string().describe("Criteria that define done"),
        depends_on: z.string().optional().describe("Comma-separated task IDs this depends on"),
        owner: z.enum(["cursor", "claude-code"]).optional().describe("Task owner (defaults based on engine mode)"),
      },
      async ({ title, context, acceptance, depends_on, owner }) => {
        const db = getDb();
        const id = nextTaskId(db);
        const taskOwner = owner || getDefaultOwner();

        db.prepare(`
          INSERT INTO tasks (id, title, status, owner, depends_on, context, acceptance)
          VALUES (?, ?, 'assigned', ?, ?, ?, ?)
        `).run(id, title, taskOwner, depends_on || null, context, acceptance);

        db.prepare(
          "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
        ).run(role, `Created task ${id}: ${title} (owner: ${taskOwner})`);

        return {
          content: [{
            type: "text",
            text: `Created ${id}: "${title}" (assigned to ${taskOwner}).`
          }]
        };
      }
    );
  }

  if (access.task_claim) {
    server.tool(
      "claim_task",
      "Claim a task and set it to in-progress. Works on 'assigned' or 'changes-requested' tasks.",
      { task_id: z.string().describe("Task ID to claim, e.g. T-001") },
      async ({ task_id }) => {
        const db = getDb();
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
  }

  if (access.save_plan) {
    server.tool(
      "save_plan",
      "Save your implementation plan for a task.",
      {
        task_id: z.string().describe("Task ID"),
        plan: z.string().describe("Your implementation plan"),
      },
      async ({ task_id, plan }) => {
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
  }

  if (access.task_submit) {
    server.tool(
      "submit_for_review",
      "Mark a task as complete and submit for review.",
      {
        task_id: z.string().describe("Task ID"),
        summary: z.string().describe("1-3 line summary of what was done"),
      },
      async ({ task_id, summary }) => {
        const db = getDb();
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
          "UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ?"
        ).run(task_id);

        db.prepare(
          "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
        ).run(role, `Submitted ${task_id} for review: ${summary}`);

        return {
          content: [{
            type: "text",
            text: `${task_id} submitted for review. Call get_my_status to see your next action.`
          }]
        };
      }
    );
  }
}
