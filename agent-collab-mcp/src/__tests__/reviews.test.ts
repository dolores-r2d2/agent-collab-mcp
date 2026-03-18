import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

describe("reviews", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'assigned', owner TEXT DEFAULT 'cursor', depends_on TEXT, context TEXT, acceptance TEXT, plan TEXT, summary TEXT, priority INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, round INTEGER, verdict TEXT, issues TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), agent TEXT, action TEXT);
      CREATE TABLE file_reservations (path TEXT PRIMARY KEY, task_id TEXT NOT NULL, reserved_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE task_transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, from_status TEXT, to_status TEXT, agent TEXT, transitioned_at TEXT DEFAULT (datetime('now')));
    `);
    db.exec("INSERT INTO tasks (id, title, status) VALUES ('T-001', 'Test task', 'review')");
  });

  it("increments review round numbers", () => {
    db.prepare("INSERT INTO reviews (task_id, round, verdict) VALUES (?, ?, ?)").run("T-001", 1, "changes-requested");
    const last = db.prepare("SELECT round FROM reviews WHERE task_id = 'T-001' ORDER BY round DESC LIMIT 1").get() as { round: number };
    expect(last.round).toBe(1);

    db.prepare("INSERT INTO reviews (task_id, round, verdict) VALUES (?, ?, ?)").run("T-001", 2, "approved");
    const last2 = db.prepare("SELECT round FROM reviews WHERE task_id = 'T-001' ORDER BY round DESC LIMIT 1").get() as { round: number };
    expect(last2.round).toBe(2);
  });

  it("approved verdict sets task status to done", () => {
    db.prepare("INSERT INTO reviews (task_id, round, verdict) VALUES (?, ?, ?)").run("T-001", 1, "approved");
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'T-001'").run();
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("done");
  });

  it("changes-requested verdict sets task status to changes-requested", () => {
    db.prepare("INSERT INTO reviews (task_id, round, verdict, issues) VALUES (?, ?, ?, ?)").run(
      "T-001", 1, "changes-requested",
      JSON.stringify([{ file: "src/foo.ts", description: "Missing error handling", severity: "critical" }])
    );
    db.prepare("UPDATE tasks SET status = 'changes-requested' WHERE id = 'T-001'").run();
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-001'").get() as { status: string };
    expect(task.status).toBe("changes-requested");
  });

  it("stores and retrieves structured issues", () => {
    const issues = [
      { file: "src/index.ts", line: 42, description: "Null check missing", severity: "critical" },
      { file: "src/utils.ts", description: "Could use a helper", severity: "note" },
    ];
    db.prepare("INSERT INTO reviews (task_id, round, verdict, issues) VALUES (?, ?, ?, ?)").run(
      "T-001", 1, "changes-requested", JSON.stringify(issues)
    );
    const review = db.prepare("SELECT issues FROM reviews WHERE task_id = 'T-001'").get() as { issues: string };
    const parsed = JSON.parse(review.issues);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].severity).toBe("critical");
    expect(parsed[1].file).toBe("src/utils.ts");
  });

  it("clears file reservations on approval", () => {
    db.prepare("INSERT INTO file_reservations (path, task_id) VALUES (?, ?)").run("src/foo.ts", "T-001");
    expect(db.prepare("SELECT COUNT(*) as cnt FROM file_reservations WHERE task_id = 'T-001'").get()).toEqual({ cnt: 1 });

    db.prepare("DELETE FROM file_reservations WHERE task_id = 'T-001'").run();
    expect(db.prepare("SELECT COUNT(*) as cnt FROM file_reservations WHERE task_id = 'T-001'").get()).toEqual({ cnt: 0 });
  });

  it("records state transitions", () => {
    db.prepare("INSERT INTO task_transitions (task_id, from_status, to_status, agent) VALUES (?, ?, ?, ?)").run(
      "T-001", "review", "done", "claude-code"
    );
    const transitions = db.prepare("SELECT * FROM task_transitions WHERE task_id = 'T-001'").all() as any[];
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_status).toBe("review");
    expect(transitions[0].to_status).toBe("done");
  });
});
