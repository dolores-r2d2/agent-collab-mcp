/**
 * Cross-agent dispatch module.
 * Spawns counterpart agent CLIs as detached background processes
 * so the MCP server can orchestrate without human intervention.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { getEngineMode, getRole, getDb, isSingleEngine } from "./db.js";
import { logToFile } from "./logger.js";

export interface DispatchResult {
  dispatched: boolean;
  pid?: number;
  logFile?: string;
  reason?: string;
}

function cliExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureLogDir(): string {
  const logDir = path.join(process.cwd(), "scripts", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function getDispatchTimeoutMs(): number {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'dispatch_timeout_seconds'").get() as { value: string } | undefined;
    if (row) return parseInt(row.value, 10) * 1000;
  } catch { /* use default */ }
  return 5 * 60 * 1000; // 5 minutes default
}

function recordDispatch(pid: number, role: string, logFile: string): number {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO dispatches (pid, role, log_file, status) VALUES (?, ?, ?, 'running')"
  ).run(pid, role, logFile);
  return Number(result.lastInsertRowid);
}

function completeDispatch(dispatchId: number, status: "completed" | "timeout" | "failed"): void {
  const db = getDb();
  db.prepare(
    "UPDATE dispatches SET status = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(status, dispatchId);
}

/**
 * Watchdog: polls the DB for expected state changes after dispatch.
 * Kills the process if no progress is detected within the timeout.
 */
function startWatchdog(
  child: ChildProcess,
  dispatchId: number,
  expectation: { table: string; countQuery: string; initialCount: number },
  timeoutMs: number
): void {
  const interval = 30_000; // poll every 30s
  const start = Date.now();

  const timer = setInterval(() => {
    const elapsed = Date.now() - start;

    // Check if process is still alive
    try { process.kill(child.pid!, 0); } catch {
      clearInterval(timer);
      completeDispatch(dispatchId, "completed");
      logToFile("dispatch_completed", { dispatch_id: dispatchId, elapsed_ms: elapsed });
      return;
    }

    // Check for progress
    try {
      const db = getDb();
      const row = db.prepare(expectation.countQuery).get() as { cnt: number };
      if (row.cnt > expectation.initialCount) {
        clearInterval(timer);
        completeDispatch(dispatchId, "completed");
        logToFile("dispatch_progress_detected", { dispatch_id: dispatchId, elapsed_ms: elapsed });
        return;
      }
    } catch { /* DB read failure, keep polling */ }

    if (elapsed >= timeoutMs) {
      clearInterval(timer);
      try { process.kill(child.pid!, "SIGTERM"); } catch { /* already dead */ }
      completeDispatch(dispatchId, "timeout");
      const role = getRole();
      const db = getDb();
      db.prepare("INSERT INTO activity_log (agent, action) VALUES (?, ?)").run(
        role,
        `Watchdog killed dispatch ${dispatchId} (PID ${child.pid}) after ${Math.round(elapsed / 1000)}s timeout`
      );
      logToFile("dispatch_timeout", { dispatch_id: dispatchId, pid: child.pid, elapsed_ms: elapsed });
    }
  }, interval);

  timer.unref();
}

const NEGATIVE_CONSTRAINTS = [
  "Do NOT write, create, or edit any files.",
  "Do NOT use Bash, shell commands, or scripts.",
  "Do NOT use the Write, Edit, or Bash tools.",
  "Use ONLY MCP tools from the agent-collab server for all actions.",
].join(" ");

/**
 * Spawns a CLI agent as a detached background process.
 * Uses agent definitions when dispatching via Claude Code CLI.
 * Returns immediately — the child runs independently.
 */
export function dispatchAgent(
  target: "reviewer" | "builder",
  prompt: string
): DispatchResult {
  const mode = getEngineMode();
  const myRole = getRole();

  if (isSingleEngine()) {
    return { dispatched: false, reason: "Single-engine mode — no counterpart to dispatch." };
  }

  let cmd: string;
  let args: string[];

  if (target === "reviewer") {
    if (mode === "both" && myRole === "cursor") {
      if (!cliExists("claude")) {
        return { dispatched: false, reason: "claude CLI not found on PATH. Install it or run review manually." };
      }
      cmd = "claude";
      args = ["agent", "task-reviewer", "--permission-mode", "bypassPermissions", "-p", prompt];
    } else if (mode === "both" && myRole === "claude-code") {
      if (!cliExists("agent")) {
        return { dispatched: false, reason: "agent CLI not found on PATH." };
      }
      cmd = "agent";
      args = ["-p", "--force", "--workspace", ".", prompt];
    } else {
      return { dispatched: false, reason: `Cannot dispatch reviewer in mode=${mode}, role=${myRole}` };
    }
  } else {
    if (mode === "both" && myRole === "claude-code") {
      if (!cliExists("agent")) {
        return { dispatched: false, reason: "agent CLI not found on PATH." };
      }
      cmd = "agent";
      args = ["-p", "--force", "--workspace", ".", prompt];
    } else if (mode === "both" && myRole === "cursor") {
      if (!cliExists("claude")) {
        return { dispatched: false, reason: "claude CLI not found on PATH." };
      }
      cmd = "claude";
      args = ["-p", "--permission-mode", "bypassPermissions", prompt];
    } else {
      return { dispatched: false, reason: `Cannot dispatch builder in mode=${mode}, role=${myRole}` };
    }
  }

  const logDir = ensureLogDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logDir, `dispatch-${target}-${ts}.log`);
  const out = fs.openSync(logFile, "w");

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: process.cwd(),
  });

  child.unref();
  const pid = child.pid ?? 0;
  const relLogFile = path.relative(process.cwd(), logFile);

  fs.writeSync(out, `--- Dispatched: ${cmd} ${args.join(" ")}\n--- PID: ${pid}\n--- Time: ${new Date().toISOString()}\n---\n`);

  const db = getDb();
  db.prepare(
    "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
  ).run(getRole(), `Dispatched ${target} (PID ${pid}, log: ${path.basename(logFile)})`);

  const dispatchId = recordDispatch(pid, target, relLogFile);
  logToFile("dispatch_started", { dispatch_id: dispatchId, target, pid, cmd, log_file: relLogFile });

  return {
    dispatched: true,
    pid,
    logFile: relLogFile,
  };
}

export function dispatchReview(taskIds: string[]): DispatchResult {
  const idList = taskIds.join(", ");
  const prompt = taskIds.length === 1
    ? `Call get_my_status from the agent-collab MCP. Then get_task("${taskIds[0]}") to read details. Review the implementation files and call review_task with your verdict. ${NEGATIVE_CONSTRAINTS}`
    : `Call get_my_status from the agent-collab MCP. You have ${taskIds.length} tasks to review: ${idList}. For each, call get_task, review the files, then review_task with your verdict. ${NEGATIVE_CONSTRAINTS}`;

  return dispatchAgent("reviewer", prompt);
}

export function dispatchBuilder(taskIds?: string[], message?: string): DispatchResult {
  let prompt: string;
  if (taskIds && taskIds.length > 0) {
    const idList = taskIds.join(", ");
    prompt = `Call get_my_status from the agent-collab MCP. Tasks assigned to you: ${idList}. Claim the first one with claim_task, implement it, then submit_for_review.`;
  } else if (message) {
    prompt = `Call get_my_status from the agent-collab MCP. ${message}`;
  } else {
    prompt = `Call get_my_status from the agent-collab MCP. Check for assigned tasks and start working.`;
  }

  return dispatchAgent("builder", prompt);
}

export function dispatchArchitect(userRequest: string): DispatchResult {
  if (isSingleEngine()) {
    return { dispatched: false, reason: "Single-engine mode — you are the architect. Create the HLD and tasks yourself." };
  }

  if (!cliExists("claude")) {
    return { dispatched: false, reason: "claude CLI not found on PATH. Install Claude Code CLI or create tasks manually." };
  }

  const prompt = `Call get_my_status from the agent-collab MCP. You are the Architect. Create an HLD with set_context("hld", ...) and then break the work into tasks with create_task. Set notify_builder=true on the LAST create_task call. ${NEGATIVE_CONSTRAINTS} The user wants: ${userRequest}`;

  const logDir = ensureLogDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logDir, `dispatch-architect-${ts}.log`);
  const out = fs.openSync(logFile, "w");

  const child = spawn("claude", ["agent", "architect", "--permission-mode", "bypassPermissions", "-p", prompt], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: process.cwd(),
  });

  child.unref();
  const pid = child.pid ?? 0;
  const relLogFile = path.relative(process.cwd(), logFile);

  fs.writeSync(out, `--- Dispatched architect: claude agent architect ...\n--- PID: ${pid}\n--- Time: ${new Date().toISOString()}\n--- Request: ${userRequest}\n---\n`);

  const db = getDb();
  db.prepare(
    "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
  ).run(getRole(), `Invoked architect for: ${userRequest.slice(0, 100)} (PID ${pid})`);

  const dispatchId = recordDispatch(pid, "architect", relLogFile);
  logToFile("dispatch_started", { dispatch_id: dispatchId, target: "architect", pid, log_file: relLogFile });

  // Watchdog: expect new tasks to appear within the timeout
  const taskCount = (db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as { cnt: number }).cnt;
  startWatchdog(child, dispatchId, {
    table: "tasks",
    countQuery: "SELECT COUNT(*) as cnt FROM tasks",
    initialCount: taskCount,
  }, getDispatchTimeoutMs());

  return {
    dispatched: true,
    pid,
    logFile: relLogFile,
  };
}

function formatResult(r: DispatchResult): string {
  if (r.dispatched) {
    return `Dispatched (PID: ${r.pid}, log: ${r.logFile})`;
  }
  return `Not dispatched: ${r.reason}`;
}

export { formatResult };
