import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole } from "../db.js";
import { NOT_SETUP, err } from "../errors.js";

export function registerCommentTools(server: McpServer): void {
  server.tool(
    "add_comment",
    "Add a comment to a task for discussion between agents.",
    {
      task_id: z.string().describe("Task ID"),
      message: z.string().describe("Comment message"),
    },
    async ({ task_id, message }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const role = getRole();

      const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(task_id);
      if (!task) return err("NOT_FOUND", `Task ${task_id} not found.`);

      db.prepare("INSERT INTO task_comments (task_id, agent, message) VALUES (?, ?, ?)").run(task_id, role, message);
      const count = (db.prepare("SELECT COUNT(*) as cnt FROM task_comments WHERE task_id = ?").get(task_id) as { cnt: number }).cnt;
      return { content: [{ type: "text", text: `Comment added to ${task_id} (${count} total).` }] };
    }
  );

  server.tool(
    "get_comments",
    "Get all comments for a task.",
    { task_id: z.string().describe("Task ID") },
    async ({ task_id }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const comments = db.prepare(
        "SELECT agent, message, created_at FROM task_comments WHERE task_id = ? ORDER BY id"
      ).all(task_id) as { agent: string; message: string; created_at: string }[];

      if (comments.length === 0) {
        return { content: [{ type: "text", text: `No comments on ${task_id}.` }] };
      }

      let text = `${comments.length} comment(s) on ${task_id}:\n\n`;
      for (const c of comments) {
        text += `[${c.created_at}] ${c.agent}: ${c.message}\n`;
      }
      return { content: [{ type: "text", text }] };
    }
  );
}
