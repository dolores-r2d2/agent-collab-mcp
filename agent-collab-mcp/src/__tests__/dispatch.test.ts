import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

describe("dispatch tracking", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid INTEGER NOT NULL,
        role TEXT NOT NULL,
        log_file TEXT,
        status TEXT DEFAULT 'running',
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), agent TEXT, action TEXT);
    `);
  });

  it("records a dispatch and defaults to running", () => {
    db.prepare("INSERT INTO dispatches (pid, role, log_file) VALUES (?, ?, ?)").run(12345, "reviewer", "logs/test.log");
    const row = db.prepare("SELECT * FROM dispatches WHERE pid = 12345").get() as any;
    expect(row.status).toBe("running");
    expect(row.completed_at).toBeNull();
  });

  it("marks dispatch as completed with timestamp", () => {
    const result = db.prepare("INSERT INTO dispatches (pid, role) VALUES (?, ?)").run(99, "architect");
    const id = Number(result.lastInsertRowid);
    db.prepare("UPDATE dispatches SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(id);
    const row = db.prepare("SELECT * FROM dispatches WHERE id = ?").get(id) as any;
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();
  });

  it("marks dispatch as timeout", () => {
    const result = db.prepare("INSERT INTO dispatches (pid, role) VALUES (?, ?)").run(88, "builder");
    const id = Number(result.lastInsertRowid);
    db.prepare("UPDATE dispatches SET status = 'timeout', completed_at = datetime('now') WHERE id = ?").run(id);
    const row = db.prepare("SELECT * FROM dispatches WHERE id = ?").get(id) as any;
    expect(row.status).toBe("timeout");
  });

  it("queries active dispatches", () => {
    db.prepare("INSERT INTO dispatches (pid, role, status) VALUES (?, ?, 'running')").run(1, "reviewer");
    db.prepare("INSERT INTO dispatches (pid, role, status) VALUES (?, ?, 'completed')").run(2, "architect");
    db.prepare("INSERT INTO dispatches (pid, role, status) VALUES (?, ?, 'running')").run(3, "builder");

    const active = db.prepare("SELECT * FROM dispatches WHERE status = 'running'").all() as any[];
    expect(active.length).toBe(2);
    expect(active.map((d: any) => d.pid)).toEqual([1, 3]);
  });

  it("reads dispatch_timeout_seconds from config with default", () => {
    const row = db.prepare("SELECT value FROM config WHERE key = 'dispatch_timeout_seconds'").get() as { value: string } | undefined;
    expect(row).toBeUndefined();

    db.prepare("INSERT INTO config (key, value) VALUES ('dispatch_timeout_seconds', '120')").run();
    const row2 = db.prepare("SELECT value FROM config WHERE key = 'dispatch_timeout_seconds'").get() as { value: string };
    expect(parseInt(row2.value, 10) * 1000).toBe(120_000);
  });
});
