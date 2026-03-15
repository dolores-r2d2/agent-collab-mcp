import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, getRole, isSingleEngine } from "../db.js";
import { dispatchReview, dispatchBuilder, formatResult } from "../dispatch.js";

interface TaskRow {
  id: string;
  title: string;
  status: string;
}

export function registerDispatchTools(server: McpServer): void {
  if (isSingleEngine()) return;

  const role = getRole();

  server.tool(
    "trigger_review",
    "Invoke the reviewer agent to review tasks. Auto-spawns the counterpart CLI in the background.",
    {
      task_id: z.string().optional().describe("Specific task ID to review, or omit to review all tasks in 'review' status"),
    },
    async ({ task_id }) => {
      const db = getDb();

      let taskIds: string[];
      if (task_id) {
        const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(task_id) as TaskRow | undefined;
        if (!task) return { content: [{ type: "text", text: `Task ${task_id} not found.` }] };
        if (task.status !== "review") {
          return { content: [{ type: "text", text: `Task ${task_id} is "${task.status}", not "review". Nothing to review.` }] };
        }
        taskIds = [task_id];
      } else {
        const tasks = db.prepare("SELECT id FROM tasks WHERE status = 'review' ORDER BY id").all() as TaskRow[];
        if (tasks.length === 0) {
          return { content: [{ type: "text", text: "No tasks in review status." }] };
        }
        taskIds = tasks.map(t => t.id);
      }

      const result = dispatchReview(taskIds);

      let text = `Trigger review for ${taskIds.length} task(s): ${taskIds.join(", ")}\n`;
      text += formatResult(result);
      if (result.dispatched) {
        text += `\n\nThe reviewer is working in the background. Call get_my_status later to check progress.`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "notify_builder",
    "Invoke the builder agent to pick up assigned tasks. Auto-spawns the counterpart CLI in the background.",
    {
      message: z.string().optional().describe("Optional context message for the builder"),
    },
    async ({ message }) => {
      const db = getDb();
      const assigned = db.prepare("SELECT id FROM tasks WHERE status = 'assigned' ORDER BY id").all() as TaskRow[];

      if (assigned.length === 0) {
        return { content: [{ type: "text", text: "No assigned tasks to work on." }] };
      }

      const taskIds = assigned.map(t => t.id);
      const result = dispatchBuilder(taskIds, message);

      let text = `Notified builder about ${taskIds.length} assigned task(s): ${taskIds.join(", ")}\n`;
      text += formatResult(result);
      if (result.dispatched) {
        text += `\n\nThe builder is working in the background. Call get_my_status later to check progress.`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "run_loop",
    "Run the full implement-review-fix loop for all tasks. Dispatches agents and polls until done or max rounds reached.",
    {
      max_rounds: z.number().optional().describe("Max review rounds per task (default: 3)"),
      max_tasks: z.number().optional().describe("Max tasks to process (default: all)"),
      timeout_seconds: z.number().optional().describe("Timeout per agent invocation in seconds (default: 300)"),
    },
    async ({ max_rounds, max_tasks, timeout_seconds }) => {
      const maxR = max_rounds ?? 3;
      const maxT = max_tasks ?? 999;
      const timeout = (timeout_seconds ?? 300) * 1000;
      const db = getDb();

      const allTasks = db.prepare(
        "SELECT id, status FROM tasks WHERE status IN ('assigned', 'review', 'changes-requested') ORDER BY id"
      ).all() as TaskRow[];

      const tasks = allTasks.slice(0, maxT);
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No actionable tasks found." }] };
      }

      const results: { id: string; outcome: string }[] = [];
      const log: string[] = [];

      for (const task of tasks) {
        log.push(`\n--- Processing ${task.id} (status: ${task.status}) ---`);

        let currentStatus = task.status;
        let round = 0;

        while (round < maxR) {
          currentStatus = (db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as TaskRow).status;

          if (currentStatus === "done") {
            log.push(`${task.id}: Done!`);
            results.push({ id: task.id, outcome: "done" });
            break;
          }

          if (currentStatus === "assigned" || currentStatus === "changes-requested") {
            log.push(`${task.id}: Dispatching builder...`);
            const br = dispatchBuilder([task.id]);
            log.push(`  ${formatResult(br)}`);
            if (!br.dispatched) {
              results.push({ id: task.id, outcome: `builder-failed: ${br.reason}` });
              break;
            }
            const newStatus = await pollForStatus(db, task.id, ["review", "done"], timeout);
            if (!newStatus) {
              log.push(`${task.id}: Timed out waiting for builder`);
              results.push({ id: task.id, outcome: "timeout-builder" });
              break;
            }
            currentStatus = newStatus;
            if (currentStatus === "done") {
              log.push(`${task.id}: Done!`);
              results.push({ id: task.id, outcome: "done" });
              break;
            }
          }

          if (currentStatus === "review") {
            round++;
            log.push(`${task.id}: Review round ${round}/${maxR}...`);
            const rr = dispatchReview([task.id]);
            log.push(`  ${formatResult(rr)}`);
            if (!rr.dispatched) {
              results.push({ id: task.id, outcome: `reviewer-failed: ${rr.reason}` });
              break;
            }
            const newStatus = await pollForStatus(db, task.id, ["done", "changes-requested"], timeout);
            if (!newStatus) {
              log.push(`${task.id}: Timed out waiting for reviewer`);
              results.push({ id: task.id, outcome: "timeout-reviewer" });
              break;
            }
            currentStatus = newStatus;
            if (currentStatus === "done") {
              log.push(`${task.id}: Approved on round ${round}!`);
              results.push({ id: task.id, outcome: "done" });
              break;
            }
            log.push(`${task.id}: Changes requested, round ${round}`);
          }
        }

        if (round >= maxR) {
          log.push(`${task.id}: Max rounds (${maxR}) reached`);
          results.push({ id: task.id, outcome: "max-rounds" });
        }
      }

      const completed = results.filter(r => r.outcome === "done").length;
      const failed = results.filter(r => r.outcome !== "done").length;

      let text = `Loop complete: ${completed} done, ${failed} incomplete out of ${results.length} tasks\n\n`;
      text += "Results:\n";
      for (const r of results) {
        text += `  ${r.id}: ${r.outcome}\n`;
      }
      text += "\nLog:\n" + log.join("\n");

      return { content: [{ type: "text", text }] };
    }
  );
}

async function pollForStatus(
  db: ReturnType<typeof getDb>,
  taskId: string,
  targetStatuses: string[],
  timeoutMs: number
): Promise<string | null> {
  const start = Date.now();
  const interval = 5000;

  while (Date.now() - start < timeoutMs) {
    await sleep(interval);
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
    if (row && targetStatuses.includes(row.status)) {
      return row.status;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
