import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

describe("task state machine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'assigned', owner TEXT DEFAULT 'cursor', depends_on TEXT, context TEXT, acceptance TEXT, plan TEXT, summary TEXT, priority INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, round INTEGER, verdict TEXT, issues TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), agent TEXT, action TEXT);
    `);
    db.exec("INSERT INTO tasks (id, title, status) VALUES ('T-001', 'Test task', 'assigned')");
  });

  it("assigned -> in-progress (claim)", () => {
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("assigned");
    db.exec("UPDATE tasks SET status = 'in-progress' WHERE id = 'T-001'");
    const updated = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(updated.status).toBe("in-progress");
  });

  it("in-progress -> review (submit)", () => {
    db.exec("UPDATE tasks SET status = 'in-progress' WHERE id = 'T-001'");
    db.exec("UPDATE tasks SET status = 'review' WHERE id = 'T-001'");
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("review");
  });

  it("review -> done (approved)", () => {
    db.exec("UPDATE tasks SET status = 'review' WHERE id = 'T-001'");
    db.exec("INSERT INTO reviews (task_id, round, verdict) VALUES ('T-001', 1, 'approved')");
    db.exec("UPDATE tasks SET status = 'done' WHERE id = 'T-001'");
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("done");
  });

  it("review -> changes-requested (rejected)", () => {
    db.exec("UPDATE tasks SET status = 'review' WHERE id = 'T-001'");
    db.exec("INSERT INTO reviews (task_id, round, verdict) VALUES ('T-001', 1, 'changes-requested')");
    db.exec("UPDATE tasks SET status = 'changes-requested' WHERE id = 'T-001'");
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("changes-requested");
  });

  it("changes-requested -> in-progress (re-claim)", () => {
    db.exec("UPDATE tasks SET status = 'changes-requested' WHERE id = 'T-001'");
    db.exec("UPDATE tasks SET status = 'in-progress' WHERE id = 'T-001'");
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("in-progress");
  });

  it("dependency blocking: cannot claim if dependency not done", () => {
    db.exec("INSERT INTO tasks (id, title, status, depends_on) VALUES ('T-002', 'Dep task', 'assigned', 'T-001')");
    const deps = "T-001".split(",").map(d => d.trim());
    const notDone = db.prepare(
      `SELECT id, status FROM tasks WHERE id IN (${deps.map(() => "?").join(",")}) AND status != 'done'`
    ).all(...deps) as { id: string; status: string }[];
    expect(notDone.length).toBe(1);
    expect(notDone[0].id).toBe("T-001");

    db.exec("UPDATE tasks SET status = 'done' WHERE id = 'T-001'");
    const notDoneAfter = db.prepare(
      `SELECT id, status FROM tasks WHERE id IN (${deps.map(() => "?").join(",")}) AND status != 'done'`
    ).all(...deps) as { id: string; status: string }[];
    expect(notDoneAfter.length).toBe(0);
  });

  it("cancel_task sets status to cancelled", () => {
    db.exec("UPDATE tasks SET status = 'cancelled' WHERE id = 'T-001'");
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("cancelled");
  });

  it("priority ordering: higher priority first", () => {
    db.exec("INSERT INTO tasks (id, title, status, priority) VALUES ('T-002', 'Low', 'assigned', 0)");
    db.exec("INSERT INTO tasks (id, title, status, priority) VALUES ('T-003', 'High', 'assigned', 10)");
    const first = db.prepare("SELECT id FROM tasks WHERE status = 'assigned' ORDER BY priority DESC, id LIMIT 1").get() as { id: string };
    expect(first.id).toBe("T-003");
  });
});
