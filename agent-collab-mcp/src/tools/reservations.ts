import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole } from "../db.js";
import { NOT_SETUP, err } from "../errors.js";

export function registerReservationTools(server: McpServer): void {
  server.tool(
    "reserve_files",
    "Reserve file paths for a task to prevent conflicts in parallel work.",
    {
      task_id: z.string().describe("Task ID that owns the reservation"),
      paths: z.array(z.string()).describe("File paths to reserve"),
    },
    async ({ task_id, paths }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const role = getRole();

      const conflicts = db.prepare(
        `SELECT path, task_id FROM file_reservations WHERE path IN (${paths.map(() => "?").join(",")}) AND task_id != ?`
      ).all(...paths, task_id) as { path: string; task_id: string }[];

      if (conflicts.length > 0) {
        const list = conflicts.map(c => `  ${c.path} (reserved by ${c.task_id})`).join("\n");
        return err("INVALID_STATE", `Cannot reserve — conflicts:\n${list}`);
      }

      const stmt = db.prepare("INSERT OR REPLACE INTO file_reservations (path, task_id) VALUES (?, ?)");
      for (const p of paths) stmt.run(p, task_id);

      db.prepare("INSERT INTO activity_log (agent, action) VALUES (?, ?)").run(role, `Reserved ${paths.length} file(s) for ${task_id}`);
      return { content: [{ type: "text", text: `Reserved ${paths.length} file(s) for ${task_id}.` }] };
    }
  );

  server.tool(
    "release_files",
    "Release all file reservations for a task.",
    { task_id: z.string().describe("Task ID to release files for") },
    async ({ task_id }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const count = db.prepare("SELECT COUNT(*) as cnt FROM file_reservations WHERE task_id = ?").get(task_id) as { cnt: number };
      db.prepare("DELETE FROM file_reservations WHERE task_id = ?").run(task_id);
      return { content: [{ type: "text", text: `Released ${count.cnt} file reservation(s) for ${task_id}.` }] };
    }
  );

  server.tool(
    "check_conflicts",
    "Check if file paths are reserved by other tasks.",
    { paths: z.array(z.string()).describe("File paths to check") },
    async ({ paths }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const reserved = db.prepare(
        `SELECT path, task_id FROM file_reservations WHERE path IN (${paths.map(() => "?").join(",")})`
      ).all(...paths) as { path: string; task_id: string }[];

      if (reserved.length === 0) {
        return { content: [{ type: "text", text: "No conflicts — all paths are free." }] };
      }

      const list = reserved.map(r => `  ${r.path} → ${r.task_id}`).join("\n");
      return { content: [{ type: "text", text: `Reserved paths:\n${list}` }] };
    }
  );
}
