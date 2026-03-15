import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole, getActiveStrategy, getEngineMode, nextEpicId } from "../db.js";

const NOT_SETUP = { content: [{ type: "text" as const, text: "Project not set up. Call setup_project first." }] };

interface TaskRow {
  id: string;
  title: string;
  status: string;
  owner: string;
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

interface ContextRow {
  key: string;
  content: string;
  updated_at: string;
}

interface ActivityRow {
  timestamp: string;
  agent: string;
  action: string;
}

interface EpicRow {
  id: string;
  name: string;
  description: string | null;
  summary: string | null;
  strategy: string | null;
  engine_mode: string | null;
  task_count: number;
  context_json: string | null;
  activity_json: string | null;
  created_at: string;
  archived_at: string;
}

interface EpicTaskRow {
  task_id: string;
  title: string;
  status: string;
  owner: string | null;
  context: string | null;
  acceptance: string | null;
  plan: string | null;
  reviews_json: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function registerEpicTools(server: McpServer): void {
  const role = getRole();

  server.tool(
    "archive_epic",
    "Archive all current tasks into a named epic. Clears the board for new work. Past epics remain accessible for context.",
    {
      name: z.string().describe("Epic name, e.g. 'Auth Module' or 'Payment Flow v2'"),
      description: z.string().optional().describe("Short description of what this epic accomplished"),
      include_incomplete: z.boolean().optional().describe("If true, archive even if some tasks aren't done (default: false)"),
      confirm: z.boolean().optional().describe("Set to true to confirm the archive"),
    },
    async ({ name, description, include_incomplete, confirm }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();

      const tasks = db.prepare("SELECT * FROM tasks ORDER BY CAST(SUBSTR(id, 3) AS INTEGER)").all() as TaskRow[];

      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "Nothing to archive — no tasks on the board." }] };
      }

      const doneCount = tasks.filter(t => t.status === "done").length;
      const notDone = tasks.filter(t => t.status !== "done");

      if (notDone.length > 0 && !include_incomplete) {
        let text = `Cannot archive: ${notDone.length} task(s) are not done:\n`;
        for (const t of notDone) text += `  - ${t.id}: "${t.title}" (${t.status})\n`;
        text += `\nEither complete them or call archive_epic with include_incomplete=true to force.`;
        return { content: [{ type: "text", text }] };
      }

      if (!confirm) {
        let text = `About to archive "${name}" with ${tasks.length} task(s) (${doneCount} done`;
        if (notDone.length > 0) text += `, ${notDone.length} incomplete`;
        text += `).\n\nThis will:\n`;
        text += `  1. Snapshot all tasks, reviews, context docs, and activity\n`;
        text += `  2. Clear the active board\n`;
        text += `  3. Keep HLD/PRD context docs for future work\n\n`;
        text += `Call archive_epic("${name}", confirm=true) to proceed.`;
        return { content: [{ type: "text", text }] };
      }

      const epicId = nextEpicId(db);
      const strategy = getActiveStrategy();
      const engineMode = getEngineMode();

      const contextDocs = db.prepare("SELECT * FROM context_docs").all() as ContextRow[];
      const activityLog = db.prepare("SELECT * FROM activity_log ORDER BY id").all() as ActivityRow[];

      const firstTask = tasks[0];
      const lastTask = tasks[tasks.length - 1];

      const totalReviews = (db.prepare(
        "SELECT COUNT(*) as cnt FROM reviews"
      ).get() as { cnt: number }).cnt;

      let summary = `# ${name}\n\n`;
      summary += `Epic: ${epicId} | ${tasks.length} tasks | ${totalReviews} review rounds\n`;
      summary += `Period: ${firstTask.created_at} — ${lastTask.updated_at}\n`;
      summary += `Strategy: ${strategy.name} | Engine: ${engineMode}\n`;
      if (description) summary += `\n${description}\n`;
      summary += `\n## Tasks\n`;
      for (const t of tasks) {
        const reviewCount = (db.prepare(
          "SELECT COUNT(*) as cnt FROM reviews WHERE task_id = ?"
        ).get(t.id) as { cnt: number }).cnt;
        summary += `- ${t.id}: ${t.title} [${t.status}]${reviewCount > 0 ? ` (${reviewCount} reviews)` : ""}\n`;
      }

      db.prepare(`
        INSERT INTO epics (id, name, description, summary, strategy, engine_mode, task_count, context_json, activity_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        epicId, name, description || null, summary,
        strategy.id, engineMode, tasks.length,
        JSON.stringify(contextDocs), JSON.stringify(activityLog)
      );

      for (const t of tasks) {
        const reviews = db.prepare(
          "SELECT round, verdict, issues, notes, created_at FROM reviews WHERE task_id = ? ORDER BY round"
        ).all(t.id) as ReviewRow[];

        db.prepare(`
          INSERT INTO epic_tasks (epic_id, task_id, title, status, owner, context, acceptance, plan, reviews_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          epicId, t.id, t.title, t.status, t.owner,
          t.context, t.acceptance, t.plan,
          reviews.length > 0 ? JSON.stringify(reviews) : null,
          t.created_at, t.updated_at
        );
      }

      db.prepare("DELETE FROM reviews").run();
      db.prepare("DELETE FROM tasks").run();
      db.prepare("DELETE FROM activity_log").run();

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Archived epic ${epicId}: "${name}" (${tasks.length} tasks)`);

      let text = `Archived as ${epicId}: "${name}"\n\n`;
      text += `${tasks.length} tasks, ${totalReviews} review rounds archived.\n`;
      text += `Board cleared — ready for new work.\n\n`;
      text += `Context docs (HLD/PRD) are preserved for continuity.\n`;
      text += `Call get_codebase_context() in future sessions to see this epic's summary.`;

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "list_epics",
    "List all archived epics with summaries. Shows project history.",
    {},
    async () => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const epics = db.prepare(
        "SELECT id, name, description, task_count, strategy, engine_mode, archived_at FROM epics ORDER BY CAST(SUBSTR(id, 3) AS INTEGER)"
      ).all() as EpicRow[];

      if (epics.length === 0) {
        return { content: [{ type: "text", text: "No archived epics yet." }] };
      }

      let text = `${epics.length} archived epic(s):\n\n`;
      for (const e of epics) {
        text += `## ${e.id}: ${e.name}\n`;
        if (e.description) text += `${e.description}\n`;
        text += `Tasks: ${e.task_count} | Strategy: ${e.strategy || "—"} | Archived: ${e.archived_at}\n\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_epic",
    "Get full details of an archived epic: tasks, reviews, context, activity.",
    { epic_id: z.string().describe("Epic ID, e.g. E-001") },
    async ({ epic_id }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const epic = db.prepare("SELECT * FROM epics WHERE id = ?").get(epic_id) as EpicRow | undefined;

      if (!epic) {
        return { content: [{ type: "text", text: `Epic ${epic_id} not found.` }] };
      }

      const tasks = db.prepare(
        "SELECT * FROM epic_tasks WHERE epic_id = ? ORDER BY task_id"
      ).all(epic_id) as EpicTaskRow[];

      let text = epic.summary || `# ${epic.name}\n`;
      text += `\n## Task Details\n`;

      for (const t of tasks) {
        text += `\n### ${t.task_id}: ${t.title} [${t.status}]\n`;
        if (t.context) text += `Context: ${t.context}\n`;
        if (t.acceptance) text += `Acceptance: ${t.acceptance}\n`;
        if (t.reviews_json) {
          try {
            const reviews = JSON.parse(t.reviews_json);
            for (const r of reviews) {
              text += `  Review round ${r.round}: ${r.verdict}`;
              if (r.notes) text += ` — ${r.notes}`;
              text += `\n`;
            }
          } catch { /* skip malformed */ }
        }
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_codebase_context",
    "Get current HLD/PRD plus summaries of all past epics. Call this before starting new work to understand the codebase history.",
    {},
    async () => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();

      const contextDocs = db.prepare("SELECT key, content, updated_at FROM context_docs").all() as ContextRow[];
      const epics = db.prepare(
        "SELECT id, name, summary, task_count, archived_at FROM epics ORDER BY CAST(SUBSTR(id, 3) AS INTEGER)"
      ).all() as EpicRow[];

      let text = "";

      if (contextDocs.length > 0) {
        text += "## Current Context Documents\n\n";
        for (const doc of contextDocs) {
          text += `### ${doc.key.toUpperCase()} (updated ${doc.updated_at})\n${doc.content}\n\n`;
        }
      } else {
        text += "No context documents (HLD/PRD) set yet.\n\n";
      }

      if (epics.length > 0) {
        text += `## Project History — ${epics.length} Archived Epic(s)\n\n`;
        for (const e of epics) {
          text += `### ${e.id}: ${e.name} (${e.task_count} tasks, archived ${e.archived_at})\n`;
          if (e.summary) {
            const lines = e.summary.split("\n").filter(l => l.startsWith("- "));
            if (lines.length > 0) {
              text += lines.join("\n") + "\n";
            }
          }
          text += "\n";
        }
      } else {
        text += "No archived epics — this is a fresh project.\n";
      }

      return { content: [{ type: "text", text }] };
    }
  );
}
