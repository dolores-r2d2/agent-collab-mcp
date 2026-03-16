import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitialized, getDb } from "../db.js";
import { NOT_SETUP } from "../errors.js";

export function registerMetricsTools(server: McpServer): void {
  server.tool(
    "get_metrics",
    "Get collaboration metrics: task durations, review rounds, approval rates.",
    {},
    async () => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();

      const totalTasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status != 'cancelled'").get() as { cnt: number }).cnt;
      const doneTasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'done'").get() as { cnt: number }).cnt;
      const totalReviews = (db.prepare("SELECT COUNT(*) as cnt FROM reviews").get() as { cnt: number }).cnt;
      const approvedFirst = (db.prepare(
        "SELECT COUNT(DISTINCT task_id) as cnt FROM reviews WHERE round = 1 AND verdict = 'approved'"
      ).get() as { cnt: number }).cnt;

      const avgRounds = totalReviews > 0
        ? (db.prepare("SELECT AVG(max_round) as avg FROM (SELECT MAX(round) as max_round FROM reviews GROUP BY task_id)").get() as { avg: number | null })?.avg ?? 0
        : 0;

      const firstPassRate = doneTasks > 0 ? Math.round((approvedFirst / doneTasks) * 100) : 0;

      const transitions = db.prepare(
        "SELECT from_status, to_status, COUNT(*) as cnt FROM task_transitions GROUP BY from_status, to_status ORDER BY cnt DESC"
      ).all() as { from_status: string; to_status: string; cnt: number }[];

      let text = "=== Collaboration Metrics ===\n\n";
      text += `Tasks: ${totalTasks} total, ${doneTasks} done\n`;
      text += `Reviews: ${totalReviews} total, avg ${avgRounds.toFixed(1)} rounds/task\n`;
      text += `First-pass approval rate: ${firstPassRate}%\n`;

      if (transitions.length > 0) {
        text += "\nState transitions:\n";
        for (const t of transitions) {
          text += `  ${t.from_status} → ${t.to_status}: ${t.cnt}x\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    }
  );
}
