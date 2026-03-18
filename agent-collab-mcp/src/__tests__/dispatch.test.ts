import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

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

  it("marks dispatch as failed", () => {
    const result = db.prepare("INSERT INTO dispatches (pid, role) VALUES (?, ?)").run(77, "architect");
    const id = Number(result.lastInsertRowid);
    db.prepare("UPDATE dispatches SET status = 'failed', completed_at = datetime('now') WHERE id = ?").run(id);
    const row = db.prepare("SELECT * FROM dispatches WHERE id = ?").get(id) as any;
    expect(row.status).toBe("failed");
    expect(row.completed_at).not.toBeNull();
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

describe("stale dispatch cleanup", () => {
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

  it("marks old running dispatches as failed", () => {
    // Insert a dispatch with a created_at 20 minutes ago (default timeout is 5 min, so 2x = 10 min)
    db.prepare(
      "INSERT INTO dispatches (pid, role, status, created_at) VALUES (?, ?, 'running', datetime('now', '-20 minutes'))"
    ).run(99999, "reviewer");

    const staleThresholdSeconds = (5 * 60 * 2); // 2x default timeout
    const result = db.prepare(`
      UPDATE dispatches SET status = 'failed', completed_at = datetime('now')
      WHERE status = 'running'
        AND created_at < datetime('now', '-' || ? || ' seconds')
    `).run(staleThresholdSeconds);

    expect(result.changes).toBe(1);
    const row = db.prepare("SELECT status FROM dispatches WHERE pid = 99999").get() as any;
    expect(row.status).toBe("failed");
  });

  it("does not mark recent running dispatches as failed", () => {
    // Insert a dispatch that just started (not stale)
    db.prepare(
      "INSERT INTO dispatches (pid, role, status) VALUES (?, ?, 'running')"
    ).run(88888, "builder");

    const staleThresholdSeconds = (5 * 60 * 2);
    const result = db.prepare(`
      UPDATE dispatches SET status = 'failed', completed_at = datetime('now')
      WHERE status = 'running'
        AND created_at < datetime('now', '-' || ? || ' seconds')
    `).run(staleThresholdSeconds);

    expect(result.changes).toBe(0);
    const row = db.prepare("SELECT status FROM dispatches WHERE pid = 88888").get() as any;
    expect(row.status).toBe("running");
  });

  it("does not touch completed dispatches", () => {
    db.prepare(
      "INSERT INTO dispatches (pid, role, status, created_at) VALUES (?, ?, 'completed', datetime('now', '-30 minutes'))"
    ).run(77777, "architect");

    const staleThresholdSeconds = (5 * 60 * 2);
    db.prepare(`
      UPDATE dispatches SET status = 'failed', completed_at = datetime('now')
      WHERE status = 'running'
        AND created_at < datetime('now', '-' || ? || ' seconds')
    `).run(staleThresholdSeconds);

    const row = db.prepare("SELECT status FROM dispatches WHERE pid = 77777").get() as any;
    expect(row.status).toBe("completed");
  });
});

describe("MCP config validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects missing .claude/settings.json", () => {
    const configPath = path.join(tmpDir, ".claude", "settings.json");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("detects .claude/settings.json without agent-collab entry", () => {
    const dir = path.join(tmpDir, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      permissions: { allow: [] },
      mcpServers: { "other-server": { command: "node" } },
    }), "utf-8");

    const content = fs.readFileSync(path.join(dir, "settings.json"), "utf-8");
    expect(content.includes("agent-collab")).toBe(false);
  });

  it("validates .claude/settings.json with agent-collab entry", () => {
    const dir = path.join(tmpDir, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      mcpServers: { "agent-collab": { command: "node", args: ["./build/index.js"] } },
    }), "utf-8");

    const content = fs.readFileSync(path.join(dir, "settings.json"), "utf-8");
    expect(content.includes("agent-collab")).toBe(true);
  });

  it("merges agent-collab into existing config with other servers", () => {
    const dir = path.join(tmpDir, ".cursor");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "my-other-mcp": { command: "python", args: ["server.py"] },
      },
    }), "utf-8");

    const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    existing.mcpServers["agent-collab"] = {
      command: "node",
      args: ["./agent-collab-mcp/build/index.js"],
      env: { AGENT_ROLE: "cursor" },
    };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");

    const merged = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(merged.mcpServers["agent-collab"]).toBeDefined();
    expect(merged.mcpServers["my-other-mcp"]).toBeDefined();
    expect(merged.mcpServers["agent-collab"].env.AGENT_ROLE).toBe("cursor");
  });

  it("creates config from scratch when file is missing", () => {
    const dir = path.join(tmpDir, ".claude");
    const configPath = path.join(dir, "settings.json");
    expect(fs.existsSync(configPath)).toBe(false);

    fs.mkdirSync(dir, { recursive: true });
    const config = {
      permissions: { allow: ["mcp__agent-collab__*", "Read(*)", "Grep(*)"] },
      mcpServers: {
        "agent-collab": {
          command: "node",
          args: ["./agent-collab-mcp/build/index.js"],
          env: { AGENT_ROLE: "claude-code" },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["agent-collab"]).toBeDefined();
    expect(written.mcpServers["agent-collab"].env.AGENT_ROLE).toBe("claude-code");
  });

  it("preserves existing mcpServers when merging", () => {
    const dir = path.join(tmpDir, ".cursor");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp.json");

    const original = {
      mcpServers: {
        "server-a": { command: "node", args: ["a.js"] },
        "server-b": { command: "python", args: ["b.py"] },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(original), "utf-8");

    const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    existing.mcpServers["agent-collab"] = { command: "node", args: ["./agent-collab-mcp/build/index.js"] };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");

    const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(Object.keys(result.mcpServers)).toHaveLength(3);
    expect(result.mcpServers["server-a"]).toBeDefined();
    expect(result.mcpServers["server-b"]).toBeDefined();
    expect(result.mcpServers["agent-collab"]).toBeDefined();
  });
});
