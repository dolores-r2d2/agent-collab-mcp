import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import {
  type Strategy,
  type RoleConfig,
  type ToolAccess,
  type EngineMode,
  getStrategyDef,
  getDefaultStrategyId,
  mergeRoleConfigs,
} from "./strategies.js";

const DB_DIR = ".agent-collab";
const DB_FILE = "collab.db";
const VALID_ROLES = ["cursor", "claude-code"];

let db: Database.Database | null = null;

export function isInitialized(): boolean {
  const dbPath = path.join(process.cwd(), DB_DIR, DB_FILE);
  return fs.existsSync(dbPath);
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbDir = path.join(process.cwd(), DB_DIR);
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, DB_FILE);
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'assigned',
      owner TEXT NOT NULL DEFAULT 'cursor',
      depends_on TEXT,
      context TEXT,
      acceptance TEXT,
      plan TEXT,
      summary TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      round INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      issues TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS context_docs (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      agent TEXT NOT NULL,
      action TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS epics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      summary TEXT,
      strategy TEXT,
      engine_mode TEXT,
      task_count INTEGER DEFAULT 0,
      context_json TEXT,
      activity_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      archived_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS epic_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id TEXT NOT NULL REFERENCES epics(id),
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT,
      context TEXT,
      acceptance TEXT,
      plan TEXT,
      reviews_json TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pid INTEGER NOT NULL,
      role TEXT NOT NULL,
      log_file TEXT,
      status TEXT DEFAULT 'running',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_reservations (
      path TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      reserved_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      agent TEXT NOT NULL,
      transitioned_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 500)`);
}

export function autoSetup(): void {
  const database = getDb();
  const role = getRole();
  // Always default to "both" so both .cursor/mcp.json and .claude/settings.json are written.
  // Single-engine modes should only be set explicitly via setup_project or init.sh --engines.
  const mode: EngineMode = "both";
  setEngineMode(database, mode);
  setActiveStrategy(database, getDefaultStrategyId());
  database.prepare(
    "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
  ).run(role, `Auto-setup: strategy=${getDefaultStrategyId()}, engine=${mode}`);
}

export function getRole(): string {
  const role = process.env.AGENT_ROLE || "unknown";
  if (role !== "unknown" && !VALID_ROLES.includes(role)) {
    process.stderr.write(`WARNING: AGENT_ROLE="${role}" is not recognized. Expected "cursor" or "claude-code". Defaulting to "unknown".\n`);
  }
  return role;
}

export function getEngineMode(): EngineMode {
  const envMode = process.env.AGENT_ENGINE_MODE;
  if (envMode === "cursor-only" || envMode === "claude-code-only" || envMode === "both") {
    return envMode;
  }

  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = 'engine_mode'").get() as { value: string } | undefined;
  const val = row?.value;
  if (val === "cursor-only" || val === "claude-code-only" || val === "both") {
    return val;
  }
  return "both";
}

export function setEngineMode(db: Database.Database, mode: EngineMode): void {
  db.prepare(`
    INSERT INTO config (key, value) VALUES ('engine_mode', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(mode);
}

export function isSingleEngine(): boolean {
  return getEngineMode() !== "both";
}

export function getActiveStrategy(): Strategy {
  const db = getDb();
  const envStrategy = process.env.AGENT_STRATEGY;

  if (envStrategy) {
    const s = getStrategyDef(envStrategy);
    if (s) return s;
  }

  const row = db.prepare("SELECT value FROM config WHERE key = 'strategy'").get() as { value: string } | undefined;
  const id = row?.value || getDefaultStrategyId();
  return getStrategyDef(id) || getStrategyDef(getDefaultStrategyId())!;
}

export function setActiveStrategy(db: Database.Database, strategyId: string): void {
  db.prepare(`
    INSERT INTO config (key, value) VALUES ('strategy', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(strategyId);
}

export function getMyRoleConfig(): RoleConfig {
  const strategy = getActiveStrategy();
  const mode = getEngineMode();
  const role = getRole();

  if (mode === "both") {
    if (role === "cursor") return strategy.roles.primary;
    if (role === "claude-code") return strategy.roles.secondary;
    return mergeRoleConfigs(strategy.roles.primary, strategy.roles.secondary);
  }

  return mergeRoleConfigs(strategy.roles.primary, strategy.roles.secondary);
}

export function getToolAccess(): ToolAccess {
  return getMyRoleConfig().tools;
}

export function getDefaultOwner(): string {
  const mode = getEngineMode();
  const role = getRole();

  if (mode === "cursor-only") return "cursor";
  if (mode === "claude-code-only") return "claude-code";
  return role === "claude-code" ? "cursor" : role;
}

export function nextTaskId(db: Database.Database): string {
  const row = db.prepare(
    "SELECT id FROM tasks ORDER BY CAST(SUBSTR(id, 3) AS INTEGER) DESC LIMIT 1"
  ).get() as { id: string } | undefined;

  if (!row) return "T-001";
  const num = parseInt(row.id.replace("T-", ""), 10);
  return `T-${String(num + 1).padStart(3, "0")}`;
}

export function nextEpicId(db: Database.Database): string {
  const row = db.prepare(
    "SELECT id FROM epics ORDER BY CAST(SUBSTR(id, 3) AS INTEGER) DESC LIMIT 1"
  ).get() as { id: string } | undefined;

  if (!row) return "E-001";
  const num = parseInt(row.id.replace("E-", ""), 10);
  return `E-${String(num + 1).padStart(3, "0")}`;
}

export function recordTransition(db: Database.Database, taskId: string, fromStatus: string, toStatus: string, agent: string): void {
  db.prepare(
    "INSERT INTO task_transitions (task_id, from_status, to_status, agent) VALUES (?, ?, ?, ?)"
  ).run(taskId, fromStatus, toStatus, agent);
}
