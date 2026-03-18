import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

describe("task operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'assigned', owner TEXT DEFAULT 'cursor', depends_on TEXT, context TEXT, acceptance TEXT, plan TEXT, summary TEXT, priority INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, round INTEGER, verdict TEXT, issues TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), agent TEXT, action TEXT);
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE task_transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, from_status TEXT, to_status TEXT, agent TEXT, transitioned_at TEXT DEFAULT (datetime('now')));
    `);
  });

  it("creates task with priority", () => {
    db.prepare("INSERT INTO tasks (id, title, priority) VALUES (?, ?, ?)").run("T-001", "High prio", 10);
    db.prepare("INSERT INTO tasks (id, title, priority) VALUES (?, ?, ?)").run("T-002", "Low prio", 0);
    const first = db.prepare("SELECT id FROM tasks ORDER BY priority DESC LIMIT 1").get() as { id: string };
    expect(first.id).toBe("T-001");
  });

  it("dependency blocking: reports all blocking deps", () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-001", "Foundation", "in-progress");
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-002", "Also dep", "assigned");
    db.prepare("INSERT INTO tasks (id, title, status, depends_on) VALUES (?, ?, ?, ?)").run("T-003", "Blocked", "assigned", "T-001, T-002");

    const deps = ["T-001", "T-002"];
    const notDone = db.prepare(
      `SELECT id, status FROM tasks WHERE id IN (${deps.map(() => "?").join(",")}) AND status != 'done'`
    ).all(...deps) as { id: string; status: string }[];

    expect(notDone).toHaveLength(2);
  });

  it("dependency resolved: allows claim when all deps done", () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-001", "Foundation", "done");
    db.prepare("INSERT INTO tasks (id, title, status, depends_on) VALUES (?, ?, ?, ?)").run("T-002", "Next", "assigned", "T-001");

    const deps = ["T-001"];
    const notDone = db.prepare(
      `SELECT id, status FROM tasks WHERE id IN (${deps.map(() => "?").join(",")}) AND status != 'done'`
    ).all(...deps) as { id: string; status: string }[];

    expect(notDone).toHaveLength(0);
  });

  it("dependency status display shows status per dep", () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-001", "Done dep", "done");
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-002", "WIP dep", "in-progress");

    const depIds = ["T-001", "T-002"];
    const depStatuses = db.prepare(
      `SELECT id, status FROM tasks WHERE id IN (${depIds.map(() => "?").join(",")})`
    ).all(...depIds) as { id: string; status: string }[];

    expect(depStatuses.find(d => d.id === "T-001")!.status).toBe("done");
    expect(depStatuses.find(d => d.id === "T-002")!.status).toBe("in-progress");
    expect(depStatuses.every(d => d.status === "done")).toBe(false);
  });

  it("cancel_task preserves task for audit", () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-001", "To cancel", "assigned");
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'T-001'").run();
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'T-001'").get() as any;
    expect(task.status).toBe("cancelled");
    expect(task.title).toBe("To cancel");
  });

  it("cancelled tasks excluded from active board", () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-001", "Active", "assigned");
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("T-002", "Cancelled", "cancelled");

    const active = db.prepare("SELECT id FROM tasks WHERE status != 'cancelled'").all() as { id: string }[];
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("T-001");
  });

  it("auto_dispatch_review config defaults to enabled", () => {
    const row = db.prepare("SELECT value FROM config WHERE key = 'auto_dispatch_review'").get() as { value: string } | undefined;
    expect(row).toBeUndefined();
    // When undefined, auto-dispatch should be enabled (default true)
    const shouldAutoDispatch = !row || row.value !== "false";
    expect(shouldAutoDispatch).toBe(true);
  });

  it("auto_dispatch_review can be disabled", () => {
    db.prepare("INSERT INTO config (key, value) VALUES ('auto_dispatch_review', 'false')").run();
    const row = db.prepare("SELECT value FROM config WHERE key = 'auto_dispatch_review'").get() as { value: string };
    const shouldAutoDispatch = row.value !== "false";
    expect(shouldAutoDispatch).toBe(false);
  });
});
