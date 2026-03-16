import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

describe("db utilities", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'assigned', owner TEXT DEFAULT 'cursor', depends_on TEXT, context TEXT, acceptance TEXT, plan TEXT, summary TEXT, priority INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, round INTEGER, verdict TEXT, issues TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE epics (id TEXT PRIMARY KEY, name TEXT, task_count INTEGER DEFAULT 0, archived_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), agent TEXT, action TEXT);
    `);
  });

  it("should generate sequential task IDs", () => {
    expect(getNextId(db, "tasks", "T-")).toBe("T-001");
    db.exec("INSERT INTO tasks (id, title) VALUES ('T-001', 'Test')");
    expect(getNextId(db, "tasks", "T-")).toBe("T-002");
    db.exec("INSERT INTO tasks (id, title) VALUES ('T-002', 'Test2')");
    expect(getNextId(db, "tasks", "T-")).toBe("T-003");
  });

  it("should generate sequential epic IDs", () => {
    expect(getNextId(db, "epics", "E-")).toBe("E-001");
    db.exec("INSERT INTO epics (id, name) VALUES ('E-001', 'Test Epic')");
    expect(getNextId(db, "epics", "E-")).toBe("E-002");
  });

  it("should prune activity log when over 500 rows", () => {
    for (let i = 0; i < 510; i++) {
      db.exec(`INSERT INTO activity_log (agent, action) VALUES ('test', 'action ${i}')`);
    }
    expect((db.prepare("SELECT COUNT(*) as cnt FROM activity_log").get() as { cnt: number }).cnt).toBe(510);
    db.exec("DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 500)");
    expect((db.prepare("SELECT COUNT(*) as cnt FROM activity_log").get() as { cnt: number }).cnt).toBe(500);
  });
});

function getNextId(db: Database.Database, table: string, prefix: string): string {
  const row = db.prepare(
    `SELECT id FROM ${table} ORDER BY CAST(SUBSTR(id, ${prefix.length + 1}) AS INTEGER) DESC LIMIT 1`
  ).get() as { id: string } | undefined;
  if (!row) return `${prefix}001`;
  const num = parseInt(row.id.replace(prefix, ""), 10);
  return `${prefix}${String(num + 1).padStart(3, "0")}`;
}
