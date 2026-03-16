import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole, getToolAccess, recordTransition } from "../db.js";
import { NOT_SETUP, err } from "../errors.js";
import { parseIssues, formatIssuesList } from "../utils.js";
import type { TaskRow, ReviewRow } from "../types.js";

export function registerReviewTools(server: McpServer): void {
  server.tool(
    "get_review_feedback",
    "Get the latest review feedback for a task.",
    { task_id: z.string().describe("Task ID") },
    async ({ task_id }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const review = db.prepare(
        "SELECT round, verdict, issues, notes, created_at FROM reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1"
      ).get(task_id) as ReviewRow | undefined;

      if (!review) return err("NOT_FOUND", `No reviews found for ${task_id}.`);

      let text = `Review round ${review.round} (${review.created_at}): ${review.verdict}\n`;

      const issues = parseIssues(review.issues);
      if (issues.length > 0) {
        text += "\nIssues:\n";
        for (const issue of issues) {
          const severity = issue.severity ? `[${issue.severity}]` : "";
          text += `  ${severity} [${issue.file || "general"}${issue.line ? ":" + issue.line : ""}] ${issue.description}\n`;
        }
      }

      if (review.notes) {
        text += `\nNotes: ${review.notes}\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "review_task",
    "Write a review verdict for a task. Sets status to 'done' or 'changes-requested'.",
    {
      task_id: z.string().describe("Task ID to review"),
      verdict: z.enum(["approved", "changes-requested"]).describe("Review verdict"),
      issues: z.array(z.object({
        file: z.string().optional().describe("File path"),
        line: z.number().optional().describe("Line number"),
        description: z.string().describe("Issue description and how to fix"),
        severity: z.enum(["critical", "warning", "note"]).optional().describe("Issue severity"),
      })).optional().describe("List of issues found"),
      notes: z.string().optional().describe("General feedback or positive observations"),
    },
    async ({ task_id, verdict, issues, notes }) => {
      if (!isInitialized()) return NOT_SETUP;
      if (!getToolAccess().review_write) return err("NO_ACCESS", "review_task is not available for your current role.");

      const db = getDb();
      const role = getRole();
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as TaskRow | undefined;

      if (!task) return err("NOT_FOUND", `Task ${task_id} not found.`);

      if (task.status !== "review") {
        return err("INVALID_STATE", `Cannot review ${task_id}: status is "${task.status}". Only "review" tasks can be reviewed.`);
      }

      const lastReview = db.prepare(
        "SELECT round FROM reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1"
      ).get(task_id) as { round: number } | undefined;
      const round = (lastReview?.round || 0) + 1;

      const newStatus = verdict === "approved" ? "done" : "changes-requested";

      db.prepare(`
        INSERT INTO reviews (task_id, round, verdict, issues, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(task_id, round, verdict, issues ? JSON.stringify(issues) : null, notes || null);

      db.prepare(
        "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newStatus, task_id);
      recordTransition(db, task_id, "review", newStatus, role);

      if (newStatus === "done") {
        db.prepare("DELETE FROM file_reservations WHERE task_id = ?").run(task_id);
      }

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Reviewed ${task_id} round ${round}: ${verdict}`);

      if (verdict === "approved") {
        return {
          content: [{
            type: "text",
            text: `${task_id} APPROVED (round ${round}). Status set to done.${notes ? " Notes: " + notes : ""}`
          }]
        };
      }

      let text = `${task_id} needs changes (round ${round}). Status set to changes-requested.\n`;
      if (issues && issues.length > 0) {
        text += "\nIssues to fix:\n" + formatIssuesList(issues);
      }
      if (notes) text += `\nNotes: ${notes}`;

      return { content: [{ type: "text", text }] };
    }
  );
}
