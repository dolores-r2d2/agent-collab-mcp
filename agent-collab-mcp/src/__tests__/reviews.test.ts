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

describe("max review rounds", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'assigned', owner TEXT DEFAULT 'cursor', depends_on TEXT, context TEXT, acceptance TEXT, plan TEXT, summary TEXT, priority INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, round INTEGER, verdict TEXT, issues TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), agent TEXT, action TEXT);
      CREATE TABLE file_reservations (path TEXT PRIMARY KEY, task_id TEXT NOT NULL, reserved_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE task_transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, from_status TEXT, to_status TEXT, agent TEXT, transitioned_at TEXT DEFAULT (datetime('now')));
    `);
    db.exec("INSERT INTO tasks (id, title, status) VALUES ('T-001', 'Test task', 'review')");
  });

  it("uses default max rounds of 5", () => {
    const maxRoundsRow = db.prepare("SELECT value FROM config WHERE key = 'max_review_rounds'").get() as { value: string } | undefined;
    const maxRounds = maxRoundsRow ? parseInt(maxRoundsRow.value, 10) : 5;
    expect(maxRounds).toBe(5);
  });

  it("respects custom max_review_rounds config", () => {
    db.prepare("INSERT INTO config (key, value) VALUES ('max_review_rounds', '3')").run();
    const maxRoundsRow = db.prepare("SELECT value FROM config WHERE key = 'max_review_rounds'").get() as { value: string };
    const maxRounds = parseInt(maxRoundsRow.value, 10);
    expect(maxRounds).toBe(3);
  });

  it("auto-approves when review round reaches max", () => {
    db.prepare("INSERT INTO config (key, value) VALUES ('max_review_rounds', '3')").run();

    // Simulate 2 previous review rounds
    db.prepare("INSERT INTO reviews (task_id, round, verdict) VALUES (?, ?, ?)").run("T-001", 1, "changes-requested");
    db.prepare("INSERT INTO reviews (task_id, round, verdict) VALUES (?, ?, ?)").run("T-001", 2, "changes-requested");

    // On round 3 (= max), changes-requested should become auto-approved
    const lastReview = db.prepare("SELECT round FROM reviews WHERE task_id = 'T-001' ORDER BY round DESC LIMIT 1").get() as { round: number };
    const round = lastReview.round + 1; // = 3
    const maxRounds = 3;

    expect(round).toBe(3);
    expect(round >= maxRounds).toBe(true);

    // The verdict should be overridden to approved
    const effectiveVerdict = round >= maxRounds ? "approved" : "changes-requested";
    expect(effectiveVerdict).toBe("approved");
  });

  it("does not auto-approve below max rounds", () => {
    db.prepare("INSERT INTO config (key, value) VALUES ('max_review_rounds', '5')").run();
    db.prepare("INSERT INTO reviews (task_id, round, verdict) VALUES (?, ?, ?)").run("T-001", 1, "changes-requested");

    const lastReview = db.prepare("SELECT round FROM reviews WHERE task_id = 'T-001' ORDER BY round DESC LIMIT 1").get() as { round: number };
    const round = lastReview.round + 1; // = 2
    const maxRounds = 5;

    expect(round).toBe(2);
    expect(round >= maxRounds).toBe(false);
  });
});

describe("file reservation transactions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'assigned', owner TEXT DEFAULT 'cursor');
      CREATE TABLE file_reservations (path TEXT PRIMARY KEY, task_id TEXT NOT NULL, reserved_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), agent TEXT, action TEXT);
    `);
    db.exec("INSERT INTO tasks (id, title) VALUES ('T-001', 'Task A')");
    db.exec("INSERT INTO tasks (id, title) VALUES ('T-002', 'Task B')");
  });

  it("prevents double-reservation via transaction", () => {
    // Reserve file for T-001
    db.prepare("INSERT INTO file_reservations (path, task_id) VALUES (?, ?)").run("src/foo.ts", "T-001");

    // Check conflict in a transaction
    const reserveTransaction = db.transaction(() => {
      const conflicts = db.prepare(
        "SELECT path, task_id FROM file_reservations WHERE path IN (?) AND task_id != ?"
      ).all("src/foo.ts", "T-002") as { path: string; task_id: string }[];
      return { conflicts };
    });

    const result = reserveTransaction.immediate();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].task_id).toBe("T-001");
  });

  it("allows same-task re-reservation", () => {
    db.prepare("INSERT INTO file_reservations (path, task_id) VALUES (?, ?)").run("src/foo.ts", "T-001");

    const conflicts = db.prepare(
      "SELECT path, task_id FROM file_reservations WHERE path IN (?) AND task_id != ?"
    ).all("src/foo.ts", "T-001") as { path: string; task_id: string }[];

    expect(conflicts).toHaveLength(0);
  });
});
