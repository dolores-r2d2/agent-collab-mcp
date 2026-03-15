#!/usr/bin/env node
/**
 * Agent Collaboration Dashboard — real-time web UI for task coordination.
 * Reads from the SQLite database and serves a self-contained HTML dashboard.
 *
 * Usage: node build/dashboard.js [--port 4800]
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { getAllStrategies } from "./strategies.js";

const DEFAULT_PORT = 4800;
const DB_DIR = ".agent-collab";
const DB_FILE = "collab.db";

function findDb(): Database.Database {
  const dbPath = path.join(process.cwd(), DB_DIR, DB_FILE);
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error("Run init.sh first or start the MCP server.");
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  return db;
}

function getConfig(db: Database.Database, key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

function apiOverview(db: Database.Database) {
  const strategy = getConfig(db, "strategy", "architect-builder");
  const engineMode = getConfig(db, "engine_mode", "both");
  const strategyDef = getAllStrategies().find(s => s.id === strategy);

  const counts = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"
  ).all() as { status: string; cnt: number }[];

  const total = counts.reduce((s, r) => s + r.cnt, 0);
  const statusMap: Record<string, number> = {};
  for (const r of counts) statusMap[r.status] = r.cnt;

  return {
    strategy: {
      id: strategy,
      name: strategyDef?.name ?? strategy,
      description: strategyDef?.description ?? "",
      primary: strategyDef?.roles.primary.name ?? "Primary",
      secondary: strategyDef?.roles.secondary.name ?? "Secondary",
    },
    engine_mode: engineMode,
    tasks: { total, ...statusMap },
  };
}

function apiTasks(db: Database.Database) {
  return db.prepare(`
    SELECT t.id, t.title, t.status, t.owner, t.depends_on, t.context, t.acceptance, t.plan,
           t.created_at, t.updated_at,
           (SELECT COUNT(*) FROM reviews r WHERE r.task_id = t.id) as review_rounds,
           (SELECT verdict FROM reviews r WHERE r.task_id = t.id ORDER BY round DESC LIMIT 1) as last_verdict
    FROM tasks t ORDER BY CAST(SUBSTR(t.id, 3) AS INTEGER)
  `).all();
}

function apiActivity(db: Database.Database, limit = 50) {
  return db.prepare(
    "SELECT timestamp, agent, action FROM activity_log ORDER BY id DESC LIMIT ?"
  ).all(limit);
}

function apiTaskDetail(db: Database.Database, taskId: string) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return null;
  const reviews = db.prepare(
    "SELECT round, verdict, issues, notes, created_at FROM reviews WHERE task_id = ? ORDER BY round"
  ).all(taskId);
  const history = db.prepare(
    "SELECT timestamp, agent, action FROM activity_log WHERE action LIKE ? ORDER BY id"
  ).all(`%${taskId}%`);
  return { ...(task as object), reviews, history };
}

function apiStrategies() {
  return getAllStrategies().map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    best_for: s.best_for,
    primary: s.roles.primary.name,
    secondary: s.roles.secondary.name,
  }));
}

function apiEpics(db: Database.Database) {
  return db.prepare(
    "SELECT id, name, description, summary, strategy, engine_mode, task_count, archived_at FROM epics ORDER BY CAST(SUBSTR(id, 3) AS INTEGER) DESC"
  ).all();
}

function apiEpicDetail(db: Database.Database, epicId: string) {
  const epic = db.prepare("SELECT * FROM epics WHERE id = ?").get(epicId);
  if (!epic) return null;
  const tasks = db.prepare(
    "SELECT task_id, title, status, owner, context, acceptance, plan, reviews_json, created_at, updated_at FROM epic_tasks WHERE epic_id = ? ORDER BY task_id"
  ).all(epicId);
  return { ...(epic as object), tasks };
}

function apiContextDocs(db: Database.Database) {
  return db.prepare("SELECT key, content, updated_at FROM context_docs ORDER BY key").all();
}

function getProjectName(db: Database.Database): string {
  const row = db.prepare("SELECT value FROM config WHERE key = 'project_name'").get() as { value: string } | undefined;
  return row?.value ?? path.basename(process.cwd());
}

function parsePort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1], 10) || DEFAULT_PORT;
  }
  return DEFAULT_PORT;
}

const port = parsePort();
const db = findDb();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  if (url.pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");

    try {
      let data: unknown;
      switch (url.pathname) {
        case "/api/overview":
          data = apiOverview(db);
          break;
        case "/api/tasks":
          data = apiTasks(db);
          break;
        case "/api/activity":
          data = apiActivity(db, parseInt(url.searchParams.get("limit") ?? "50", 10));
          break;
        case "/api/task": {
          const id = url.searchParams.get("id");
          if (!id) { res.writeHead(400); res.end('{"error":"missing id"}'); return; }
          data = apiTaskDetail(db, id);
          if (!data) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
          break;
        }
        case "/api/strategies":
          data = apiStrategies();
          break;
        case "/api/epics":
          data = apiEpics(db);
          break;
        case "/api/epic": {
          const eid = url.searchParams.get("id");
          if (!eid) { res.writeHead(400); res.end('{"error":"missing id"}'); return; }
          data = apiEpicDetail(db, eid);
          if (!data) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
          break;
        }
        case "/api/project-name":
          data = { name: getProjectName(db) };
          break;
        case "/api/context":
          data = apiContextDocs(db);
          break;
        default:
          res.writeHead(404);
          res.end('{"error":"not found"}');
          return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.writeHead(200);
    res.end(DASHBOARD_HTML);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`\n  ⚡ Agent Collab Dashboard`);
  console.log(`  ➜ http://localhost:${port}\n`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Dashboard HTML — self-contained, no external dependencies
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Collab Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-0:#0a0a0f;--bg-1:#12121a;--bg-2:#1a1a27;--bg-3:#242436;
  --fg-0:#e8e8f0;--fg-1:#a0a0b8;--fg-2:#6a6a82;
  --accent:#6c5ce7;--accent-glow:#6c5ce740;
  --green:#00b894;--green-bg:#00b89418;
  --yellow:#fdcb6e;--yellow-bg:#fdcb6e18;
  --blue:#0984e3;--blue-bg:#0984e318;
  --red:#d63031;--red-bg:#d6303118;
  --orange:#e17055;--orange-bg:#e1705518;
  --cyan:#00cec9;--cyan-bg:#00cec918;
  --radius:12px;--radius-sm:8px;
  --font-sans:'Inter',system-ui,sans-serif;
  --font-mono:'JetBrains Mono',monospace;
  --shadow:0 4px 24px rgba(0,0,0,.4);
}
html{font-size:15px;background:var(--bg-0);color:var(--fg-0);font-family:var(--font-sans)}
body{min-height:100vh}

/* ── Header ─────────────────────────────────────────────── */
header{
  background:linear-gradient(135deg,var(--bg-1),var(--bg-2));
  border-bottom:1px solid var(--bg-3);
  padding:1.2rem 2rem;display:flex;align-items:center;gap:1.5rem;
  position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);
}
header h1{font-size:1.25rem;font-weight:800;letter-spacing:-.02em;
  background:linear-gradient(135deg,var(--accent),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header-meta{display:flex;gap:.75rem;margin-left:auto;align-items:center}
.badge{
  font-size:.72rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  padding:.3rem .7rem;border-radius:20px;font-family:var(--font-mono);
}
.badge-strategy{background:var(--accent-glow);color:var(--accent);border:1px solid var(--accent)}
.badge-engine{background:var(--cyan-bg);color:var(--cyan);border:1px solid var(--cyan)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--green);
  box-shadow:0 0 6px var(--green);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.refresh-label{font-size:.7rem;color:var(--fg-2);font-family:var(--font-mono)}

/* ── Layout ─────────────────────────────────────────────── */
main{display:flex;flex-direction:column;gap:1.2rem;padding:1.5rem 2rem;max-width:1800px;margin:0 auto;min-height:calc(100vh - 64px)}
.middle{display:grid;grid-template-columns:1fr 320px;gap:1.2rem;flex:1;min-height:0}
@media(max-width:1100px){.middle{grid-template-columns:1fr;grid-template-rows:auto auto}}

/* ── Stats Bar ──────────────────────────────────────────── */
.stats{grid-column:1/-1;display:flex;gap:1rem;flex-wrap:wrap}
.stat-card{
  flex:1;min-width:140px;background:var(--bg-1);border:1px solid var(--bg-3);
  border-radius:var(--radius);padding:1rem 1.2rem;
  display:flex;flex-direction:column;gap:.3rem;transition:border-color .2s;
}
.stat-card:hover{border-color:var(--accent)}
.stat-card .label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-2);font-weight:600}
.stat-card .value{font-size:1.8rem;font-weight:800;font-family:var(--font-mono);letter-spacing:-.03em}
.stat-card.total .value{color:var(--fg-0)}
.stat-card.assigned .value{color:var(--blue)}
.stat-card.in-progress .value{color:var(--yellow)}
.stat-card.review .value{color:var(--orange)}
.stat-card.changes .value{color:var(--red)}
.stat-card.done .value{color:var(--green)}

/* ── Kanban Board ───────────────────────────────────────── */
.board{overflow-x:auto;overflow-y:visible;min-width:0}
.board h2{font-size:.9rem;font-weight:700;color:var(--fg-1);text-transform:uppercase;
  letter-spacing:.08em;margin-bottom:1rem}
.kanban{display:flex;flex-wrap:nowrap;gap:.8rem;min-height:300px;min-width:min-content}
.kanban .column{width:200px;min-width:200px;flex:0 0 auto}
.column{background:var(--bg-1);border:1px solid var(--bg-3);border-radius:var(--radius);
  padding:.8rem;display:flex;flex-direction:column;gap:.6rem;min-height:200px}
.column-header{
  display:flex;align-items:center;gap:.5rem;padding-bottom:.5rem;
  border-bottom:2px solid var(--bg-3);margin-bottom:.2rem;
}
.column-header .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.column-header .col-title{font-size:.72rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.06em;color:var(--fg-2)}
.column-header .col-count{
  margin-left:auto;font-size:.65rem;font-family:var(--font-mono);
  background:var(--bg-3);padding:.15rem .45rem;border-radius:10px;color:var(--fg-2)}
.col-assigned .dot{background:var(--blue)}
.col-in-progress .dot{background:var(--yellow)}
.col-review .dot{background:var(--orange)}
.col-changes-requested .dot{background:var(--red)}
.col-done .dot{background:var(--green)}

/* ── Task Cards ─────────────────────────────────────────── */
.task-card{
  background:var(--bg-2);border:1px solid var(--bg-3);border-radius:var(--radius-sm);
  padding:.7rem .8rem;cursor:pointer;transition:all .15s;position:relative;
  overflow:hidden;
}
.task-card::before{
  content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
}
.col-assigned .task-card::before{background:var(--blue)}
.col-in-progress .task-card::before{background:var(--yellow)}
.col-review .task-card::before{background:var(--orange)}
.col-changes-requested .task-card::before{background:var(--red)}
.col-done .task-card::before{background:var(--green)}
.task-card:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:var(--shadow)}
.task-card .task-id{font-size:.65rem;font-family:var(--font-mono);color:var(--fg-2);font-weight:600}
.task-card .task-title{font-size:.82rem;font-weight:600;margin-top:.2rem;line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.task-card .task-meta{display:flex;gap:.5rem;margin-top:.4rem;align-items:center}
.task-card .task-owner{font-size:.6rem;font-family:var(--font-mono);color:var(--fg-2);
  background:var(--bg-3);padding:.1rem .4rem;border-radius:6px}
.task-card .task-reviews{font-size:.6rem;color:var(--fg-2)}

/* ── Sidebar ────────────────────────────────────────────── */
.sidebar{display:flex;flex-direction:column;gap:1.2rem}

/* ── Strategy Panel ─────────────────────────────────────── */
.panel{background:var(--bg-1);border:1px solid var(--bg-3);border-radius:var(--radius);padding:1rem 1.2rem}
.panel h3{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
  color:var(--fg-2);margin-bottom:.8rem;display:flex;align-items:center;gap:.5rem}
.panel h3 .icon{font-size:1rem}
.strategy-name{font-size:1.05rem;font-weight:700;color:var(--fg-0);margin-bottom:.3rem}
.strategy-desc{font-size:.78rem;color:var(--fg-1);line-height:1.5;margin-bottom:.8rem}
.roles-grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
.role-box{
  background:var(--bg-2);border-radius:var(--radius-sm);padding:.6rem .7rem;
  border:1px solid var(--bg-3);
}
.role-box .role-label{font-size:.6rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.06em;margin-bottom:.25rem}
.role-box .role-name{font-size:.8rem;font-weight:600}
.role-box.primary .role-label{color:var(--accent)}
.role-box.secondary .role-label{color:var(--cyan)}
.engine-mapping{
  margin-top:.7rem;font-size:.72rem;color:var(--fg-2);font-family:var(--font-mono);
  background:var(--bg-2);padding:.5rem .7rem;border-radius:var(--radius-sm);
  border:1px solid var(--bg-3);line-height:1.7;
}

/* ── Activity Feed ──────────────────────────────────────── */
.activity-list{display:flex;flex-direction:column;gap:0;max-height:400px;overflow-y:auto}
.activity-list::-webkit-scrollbar{width:4px}
.activity-list::-webkit-scrollbar-track{background:transparent}
.activity-list::-webkit-scrollbar-thumb{background:var(--bg-3);border-radius:4px}
.activity-item{
  display:grid;grid-template-columns:auto 1fr;gap:.4rem .7rem;
  padding:.55rem 0;border-bottom:1px solid var(--bg-3);align-items:start;
}
.activity-item:last-child{border-bottom:none}
.activity-ts{font-size:.6rem;font-family:var(--font-mono);color:var(--fg-2);white-space:nowrap;padding-top:.1rem}
.activity-action{font-size:.78rem;color:var(--fg-1);line-height:1.4}
.activity-agent{font-weight:600;font-size:.68rem;font-family:var(--font-mono);
  padding:.1rem .35rem;border-radius:4px;margin-right:.3rem}
.activity-agent.cursor{background:var(--accent-glow);color:var(--accent)}
.activity-agent.claude-code{background:var(--cyan-bg);color:var(--cyan)}
.activity-agent.unknown{background:var(--bg-3);color:var(--fg-2)}
.empty-state{text-align:center;padding:2rem 1rem;color:var(--fg-2);font-size:.85rem}

/* ── Task Detail Modal ──────────────────────────────────── */
.modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);
  z-index:200;display:none;align-items:center;justify-content:center;padding:2rem;
}
.modal-overlay.open{display:flex}
.modal{
  background:var(--bg-1);border:1px solid var(--bg-3);border-radius:var(--radius);
  max-width:720px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.5);
  padding:1.5rem 2rem;
}
.modal::-webkit-scrollbar{width:6px}
.modal::-webkit-scrollbar-thumb{background:var(--bg-3);border-radius:4px}
.modal-header{display:flex;align-items:center;gap:.8rem;margin-bottom:1rem}
.modal-header .task-id-big{font-family:var(--font-mono);font-weight:700;font-size:.85rem;color:var(--fg-2)}
.modal-header .task-title-big{font-size:1.1rem;font-weight:700}
.modal-close{margin-left:auto;background:none;border:none;color:var(--fg-2);font-size:1.3rem;
  cursor:pointer;padding:.3rem;border-radius:6px;transition:all .15s}
.modal-close:hover{background:var(--bg-3);color:var(--fg-0)}
.modal-status{
  display:inline-block;font-size:.7rem;font-family:var(--font-mono);font-weight:600;
  padding:.25rem .6rem;border-radius:20px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:1rem;
}
.modal-status.assigned{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue)}
.modal-status.in-progress{background:var(--yellow-bg);color:var(--yellow);border:1px solid var(--yellow)}
.modal-status.review{background:var(--orange-bg);color:var(--orange);border:1px solid var(--orange)}
.modal-status.changes-requested{background:var(--red-bg);color:var(--red);border:1px solid var(--red)}
.modal-status.done{background:var(--green-bg);color:var(--green);border:1px solid var(--green)}
.modal-section{margin-bottom:1rem}
.modal-section h4{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
  color:var(--fg-2);margin-bottom:.4rem}
.modal-section pre{
  font-family:var(--font-mono);font-size:.78rem;line-height:1.6;color:var(--fg-1);
  background:var(--bg-2);padding:.8rem 1rem;border-radius:var(--radius-sm);
  border:1px solid var(--bg-3);white-space:pre-wrap;word-break:break-word;
}
.review-entry{
  background:var(--bg-2);border:1px solid var(--bg-3);border-radius:var(--radius-sm);
  padding:.8rem 1rem;margin-bottom:.5rem;
}
.review-entry .review-header{display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem}
.review-entry .round-badge{font-family:var(--font-mono);font-size:.65rem;font-weight:600;
  background:var(--bg-3);padding:.15rem .4rem;border-radius:8px;color:var(--fg-2)}
.review-entry .verdict-badge{font-size:.65rem;font-weight:600;padding:.15rem .5rem;border-radius:8px}
.verdict-badge.approved{background:var(--green-bg);color:var(--green)}
.verdict-badge.changes-requested{background:var(--red-bg);color:var(--red)}
.review-entry .review-notes{font-size:.78rem;color:var(--fg-1);margin-top:.3rem}
.review-issue{font-size:.75rem;color:var(--fg-1);padding:.2rem 0;font-family:var(--font-mono)}
.review-issue .issue-loc{color:var(--accent)}

/* ── Task Timeline ──────────────────────────────────────── */
.timeline{display:flex;flex-direction:column;gap:0;position:relative;padding-left:1.2rem}
.timeline::before{content:'';position:absolute;left:.4rem;top:.5rem;bottom:.5rem;width:2px;background:var(--bg-3)}
.tl-entry{position:relative;padding:.5rem 0 .5rem .8rem}
.tl-entry::before{content:'';position:absolute;left:-.85rem;top:.75rem;width:10px;height:10px;border-radius:50%;border:2px solid var(--bg-3);background:var(--bg-1);z-index:1}
.tl-entry.tl-submit::before{background:var(--yellow);border-color:var(--yellow)}
.tl-entry.tl-approved::before{background:var(--green);border-color:var(--green)}
.tl-entry.tl-changes::before{background:var(--red);border-color:var(--red)}
.tl-entry.tl-claim::before{background:var(--blue);border-color:var(--blue)}
.tl-entry.tl-other::before{background:var(--fg-2);border-color:var(--fg-2)}
.tl-time{font-size:.6rem;font-family:var(--font-mono);color:var(--fg-2)}
.tl-agent{font-size:.6rem;font-family:var(--font-mono);padding:.1rem .3rem;border-radius:4px;margin-left:.3rem}
.tl-agent.cursor{background:var(--accent-glow);color:var(--accent)}
.tl-agent.claude-code{background:var(--cyan-bg);color:var(--cyan)}
.tl-body{font-size:.78rem;color:var(--fg-1);margin-top:.2rem;line-height:1.4}
.tl-summary{background:var(--bg-2);padding:.4rem .6rem;border-radius:var(--radius-sm);margin-top:.3rem;
  font-size:.75rem;color:var(--fg-1);border-left:3px solid var(--yellow)}
.tl-review-block{background:var(--bg-2);padding:.4rem .6rem;border-radius:var(--radius-sm);margin-top:.3rem;
  font-size:.75rem;border-left:3px solid var(--green)}
.tl-review-block.changes{border-left-color:var(--red)}

/* ── Context Docs ───────────────────────────────────────── */
.ctx-doc{background:var(--bg-2);border:1px solid var(--bg-3);border-radius:var(--radius-sm);
  padding:.6rem .8rem;margin-bottom:.5rem}
.ctx-doc .ctx-key{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
  color:var(--accent);margin-bottom:.3rem;cursor:pointer;display:flex;align-items:center;gap:.3rem}
.ctx-doc .ctx-key::before{content:'\\25B6';font-size:.5rem;transition:transform .2s}
.ctx-doc.open .ctx-key::before{transform:rotate(90deg)}
.ctx-doc .ctx-body{font-size:.75rem;color:var(--fg-1);line-height:1.5;display:none;
  white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;margin-top:.3rem}
.ctx-doc.open .ctx-body{display:block}
.ctx-doc .ctx-updated{font-size:.55rem;color:var(--fg-2);font-family:var(--font-mono)}

/* ── Epics ──────────────────────────────────────────────── */
.epic-item{
  background:var(--bg-2);border:1px solid var(--bg-3);border-radius:var(--radius-sm);
  padding:.6rem .8rem;margin-bottom:.5rem;cursor:pointer;transition:all .15s;
  border-left:3px solid var(--accent);
}
.epic-item:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:var(--shadow)}
.epic-item .epic-name{font-size:.82rem;font-weight:600}
.epic-item .epic-meta{font-size:.6rem;font-family:var(--font-mono);color:var(--fg-2);margin-top:.2rem}
</style>
</head>
<body>

<header>
  <h1>Agent Collab</h1>
  <span id="h-project" style="font-size:.8rem;color:var(--fg-1);font-family:var(--font-mono)"></span>
  <div class="header-meta">
    <span class="badge badge-strategy" id="h-strategy">—</span>
    <span class="badge badge-engine" id="h-engine">—</span>
    <div class="pulse"></div>
    <span class="refresh-label">auto-refresh 3s</span>
  </div>
</header>

<main>
  <section class="stats" id="stats"></section>

  <div class="middle">
    <section class="board">
      <h2>Task Board</h2>
      <div class="kanban" id="kanban"></div>
    </section>

    <aside class="sidebar">
      <div class="panel" id="strategy-panel">
        <h3><span class="icon">&#9881;</span> Strategy</h3>
        <div id="strategy-content"></div>
      </div>
      <div class="panel" id="context-panel">
        <h3><span class="icon">&#128196;</span> Context Docs</h3>
        <div id="context-docs"></div>
      </div>
      <div class="panel" id="epics-panel">
        <h3><span class="icon">&#128230;</span> Archived Epics</h3>
        <div id="epics-list"></div>
      </div>
      <div class="panel">
        <h3><span class="icon">&#9889;</span> Activity</h3>
        <div class="activity-list" id="activity"></div>
      </div>
    </aside>
  </div>
</main>

<div class="modal-overlay" id="modal-overlay">
  <div class="modal" id="modal"></div>
</div>

<script>
const API = '';
const COLS = ['assigned','in-progress','review','changes-requested','done'];
const COL_LABELS = {assigned:'Assigned','in-progress':'In Progress',review:'Review','changes-requested':'Changes Req.',done:'Done'};

async function fetchJSON(path) {
  const r = await fetch(API + path);
  return r.json();
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderStats(overview) {
  const el = document.getElementById('stats');
  const t = overview.tasks;
  const cards = [
    {cls:'total',label:'Total Tasks',value:t.total||0},
    {cls:'assigned',label:'Assigned',value:t.assigned||0},
    {cls:'in-progress',label:'In Progress',value:t['in-progress']||0},
    {cls:'review',label:'In Review',value:t.review||0},
    {cls:'changes',label:'Changes Req.',value:t['changes-requested']||0},
    {cls:'done',label:'Done',value:t.done||0},
  ];
  el.innerHTML = cards.map(c =>
    '<div class="stat-card '+c.cls+'"><span class="label">'+c.label+'</span><span class="value">'+c.value+'</span></div>'
  ).join('');
}

function renderKanban(tasks) {
  const el = document.getElementById('kanban');
  const grouped = {};
  COLS.forEach(c => grouped[c] = []);
  tasks.forEach(t => { if (grouped[t.status]) grouped[t.status].push(t); });

  el.innerHTML = COLS.map(col => {
    const items = grouped[col];
    const cards = items.length ? items.map(t =>
      '<div class="task-card" data-id="'+escHtml(t.id)+'" onclick="openTask(\\''+escHtml(t.id)+'\\')">'+
        '<div class="task-id">'+escHtml(t.id)+'</div>'+
        '<div class="task-title">'+escHtml(t.title)+'</div>'+
        '<div class="task-meta">'+
          '<span class="task-owner">'+escHtml(t.owner)+'</span>'+
          (t.review_rounds > 0 ? '<span class="task-reviews">'+t.review_rounds+' review(s)</span>' : '')+
        '</div>'+
      '</div>'
    ).join('') : '<div class="empty-state">No tasks</div>';

    return '<div class="column col-'+col+'">'+
      '<div class="column-header">'+
        '<div class="dot"></div>'+
        '<span class="col-title">'+COL_LABELS[col]+'</span>'+
        '<span class="col-count">'+items.length+'</span>'+
      '</div>'+cards+'</div>';
  }).join('');
}

function renderStrategy(overview) {
  const s = overview.strategy;
  const m = overview.engine_mode;
  document.getElementById('h-strategy').textContent = s.name;
  document.getElementById('h-engine').textContent = m;

  let mapping = '';
  if (m === 'both') {
    mapping = 'cursor \\u2192 Primary ('+escHtml(s.primary)+')\\nclaude-code \\u2192 Secondary ('+escHtml(s.secondary)+')';
  } else {
    const eng = m.replace('-only','');
    mapping = eng + ' \\u2192 Both roles ('+escHtml(s.primary)+' + '+escHtml(s.secondary)+')';
  }

  document.getElementById('strategy-content').innerHTML =
    '<div class="strategy-name">'+escHtml(s.name)+'</div>'+
    '<div class="strategy-desc">'+escHtml(s.description)+'</div>'+
    '<div class="roles-grid">'+
      '<div class="role-box primary"><div class="role-label">Primary</div><div class="role-name">'+escHtml(s.primary)+'</div></div>'+
      '<div class="role-box secondary"><div class="role-label">Secondary</div><div class="role-name">'+escHtml(s.secondary)+'</div></div>'+
    '</div>'+
    '<div class="engine-mapping">'+escHtml(mapping).replace(/\\n/g,'<br>')+'</div>';
}

function renderActivity(items) {
  const el = document.getElementById('activity');
  if (!items.length) { el.innerHTML = '<div class="empty-state">No activity yet</div>'; return; }
  el.innerHTML = items.map(a => {
    const agentCls = a.agent === 'cursor' ? 'cursor' : a.agent === 'claude-code' ? 'claude-code' : 'unknown';
    const ts = a.timestamp ? a.timestamp.replace('T',' ').slice(0,16) : '';
    return '<div class="activity-item">'+
      '<div class="activity-ts">'+escHtml(ts)+'</div>'+
      '<div class="activity-action"><span class="activity-agent '+agentCls+'">'+escHtml(a.agent)+'</span> '+escHtml(a.action)+'</div>'+
    '</div>';
  }).join('');
}

async function openTask(id) {
  const data = await fetchJSON('/api/task?id='+encodeURIComponent(id));
  if (!data) return;

  var timeline = '';
  var history = data.history || [];
  var reviews = data.reviews || [];
  var reviewIdx = 0;

  if (history.length > 0 || reviews.length > 0) {
    var entries = [];
    for (var h = 0; h < history.length; h++) {
      var a = history[h];
      var ts = a.timestamp ? a.timestamp.replace('T',' ').slice(0,16) : '';
      var agentCls = a.agent === 'cursor' ? 'cursor' : a.agent === 'claude-code' ? 'claude-code' : '';
      var action = a.action || '';
      var cls = 'tl-other';
      var body = escHtml(action);

      if (action.indexOf('Claimed') >= 0) {
        cls = 'tl-claim';
      } else if (action.indexOf('Submitted') >= 0) {
        cls = 'tl-submit';
        var sumMatch = action.indexOf(': ');
        if (sumMatch > 0) {
          var sumText = action.slice(sumMatch + 2);
          body = 'Submitted for review';
          body += '<div class="tl-summary">'+escHtml(sumText)+'</div>';
        }
      } else if (action.indexOf('Reviewed') >= 0) {
        var isApproved = action.indexOf('approved') >= 0;
        cls = isApproved ? 'tl-approved' : 'tl-changes';
        if (reviewIdx < reviews.length) {
          var rv = reviews[reviewIdx];
          reviewIdx++;
          var issuesHtml = '';
          if (rv.issues) {
            try {
              var parsed = JSON.parse(rv.issues);
              issuesHtml = parsed.map(function(i) {
                return '<div class="review-issue"><span class="issue-loc">['+(i.file||'general')+(i.line?':'+i.line:'')+']</span> '+escHtml(i.description)+'</div>';
              }).join('');
            } catch(e) { issuesHtml = escHtml(rv.issues); }
          }
          body = '<span class="verdict-badge '+(rv.verdict||'')+'">'+escHtml(rv.verdict||'')+'</span> Round '+(rv.round||'');
          body += '<div class="tl-review-block '+(rv.verdict==='changes-requested'?'changes':'')+'">'+
            issuesHtml+
            (rv.notes ? '<div style="margin-top:.3rem;color:var(--fg-1)">'+escHtml(rv.notes)+'</div>' : '')+
          '</div>';
        }
      }

      entries.push('<div class="tl-entry '+cls+'">'+
        '<div><span class="tl-time">'+escHtml(ts)+'</span><span class="tl-agent '+agentCls+'">'+escHtml(a.agent)+'</span></div>'+
        '<div class="tl-body">'+body+'</div>'+
      '</div>');
    }
    timeline = '<div class="modal-section"><h4>Timeline</h4><div class="timeline">'+entries.join('')+'</div></div>';
  }

  document.getElementById('modal').innerHTML =
    '<div class="modal-header">'+
      '<span class="task-id-big">'+escHtml(data.id)+'</span>'+
      '<span class="task-title-big">'+escHtml(data.title)+'</span>'+
      '<button class="modal-close" onclick="closeModal()">\\u2715</button>'+
    '</div>'+
    '<span class="modal-status '+data.status+'">'+escHtml(data.status)+'</span>'+
    '<div style="font-size:.75rem;color:var(--fg-2);margin-bottom:1rem">Owner: '+escHtml(data.owner)+
      (data.depends_on?' &bull; Depends: '+escHtml(data.depends_on):'')+
      ' &bull; Created: '+escHtml(data.created_at)+'</div>'+
    (data.summary ? '<div class="modal-section"><h4>Implementation Summary</h4><pre>'+escHtml(data.summary)+'</pre></div>' : '')+
    (data.context ? '<div class="modal-section"><h4>Context</h4><pre>'+escHtml(data.context)+'</pre></div>' : '')+
    (data.acceptance ? '<div class="modal-section"><h4>Acceptance Criteria</h4><pre>'+escHtml(data.acceptance)+'</pre></div>' : '')+
    (data.plan ? '<div class="modal-section"><h4>Plan</h4><pre>'+escHtml(data.plan)+'</pre></div>' : '')+
    timeline;

  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

function renderContextDocs(docs) {
  const el = document.getElementById('context-docs');
  if (!docs || docs.length === 0) {
    el.innerHTML = '<div class="empty-state">No context docs yet</div>';
    return;
  }
  el.innerHTML = docs.map(d =>
    '<div class="ctx-doc" onclick="this.classList.toggle(\\'open\\')">'+
      '<div class="ctx-key">'+escHtml(d.key).toUpperCase()+' <span class="ctx-updated">'+escHtml(d.updated_at||'')+'</span></div>'+
      '<div class="ctx-body">'+escHtml(d.content)+'</div>'+
    '</div>'
  ).join('');
}

function renderEpics(epics) {
  const el = document.getElementById('epics-list');
  if (!epics || epics.length === 0) {
    el.innerHTML = '<div class="empty-state">No archived epics</div>';
    return;
  }
  el.innerHTML = epics.map(e =>
    '<div class="epic-item" onclick="openEpic(\\''+escHtml(e.id)+'\\')">'+
      '<div class="epic-name">'+escHtml(e.id)+': '+escHtml(e.name)+'</div>'+
      '<div class="epic-meta">'+e.task_count+' tasks &bull; '+escHtml(e.archived_at||'')+'</div>'+
    '</div>'
  ).join('');
}

async function openEpic(id) {
  const data = await fetchJSON('/api/epic?id='+encodeURIComponent(id));
  if (!data) return;

  const tasks = data.tasks || [];
  const taskHtml = tasks.map(t => {
    let reviews = '';
    if (t.reviews_json) {
      try {
        const rs = JSON.parse(t.reviews_json);
        reviews = rs.map(r => '<span class="verdict-badge '+r.verdict+'">R'+r.round+': '+r.verdict+'</span>').join(' ');
      } catch(e) {}
    }
    return '<div class="review-entry"><div class="review-header">'+
      '<span class="round-badge">'+escHtml(t.task_id)+'</span>'+
      '<span class="modal-status '+t.status+'">'+escHtml(t.status)+'</span>'+
      '</div><div style="font-size:.82rem;font-weight:600;margin:.3rem 0">'+escHtml(t.title)+'</div>'+
      (reviews ? '<div style="margin-top:.2rem">'+reviews+'</div>' : '')+
      '</div>';
  }).join('');

  document.getElementById('modal').innerHTML =
    '<div class="modal-header">'+
      '<span class="task-id-big">'+escHtml(data.id)+'</span>'+
      '<span class="task-title-big">'+escHtml(data.name)+'</span>'+
      '<button class="modal-close" onclick="closeModal()">\\u2715</button>'+
    '</div>'+
    (data.description ? '<div style="color:var(--fg-1);font-size:.85rem;margin-bottom:1rem">'+escHtml(data.description)+'</div>' : '')+
    '<div style="font-size:.72rem;color:var(--fg-2);margin-bottom:1rem">'+
      data.task_count+' tasks &bull; Strategy: '+escHtml(data.strategy||'—')+' &bull; Archived: '+escHtml(data.archived_at||'')+
    '</div>'+
    (data.summary ? '<div class="modal-section"><h4>Summary</h4><pre>'+escHtml(data.summary)+'</pre></div>' : '')+
    '<div class="modal-section"><h4>Tasks</h4>'+taskHtml+'</div>';

  document.getElementById('modal-overlay').classList.add('open');
}

async function refresh() {
  try {
    const [overview, tasks, activity, epics, proj, ctxDocs] = await Promise.all([
      fetchJSON('/api/overview'),
      fetchJSON('/api/tasks'),
      fetchJSON('/api/activity?limit=30'),
      fetchJSON('/api/epics'),
      fetchJSON('/api/project-name'),
      fetchJSON('/api/context'),
    ]);
    renderStats(overview);
    renderKanban(tasks);
    renderStrategy(overview);
    renderContextDocs(ctxDocs);
    renderActivity(activity);
    renderEpics(epics);
    if (proj && proj.name) document.getElementById('h-project').textContent = proj.name;
  } catch(e) {
    console.error('Refresh failed:', e);
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
