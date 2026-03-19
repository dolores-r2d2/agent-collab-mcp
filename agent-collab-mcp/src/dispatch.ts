/**
 * Cross-agent dispatch module.
 * Spawns counterpart agent CLIs as detached background processes
 * so the MCP server can orchestrate without human intervention.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { getEngineMode, getRole, getDb, isSingleEngine, getProjectDir } from "./db.js";
import { logToFile } from "./logger.js";

export interface DispatchResult {
  dispatched: boolean;
  pid?: number;
  logFile?: string;
  reason?: string;
}

interface McpConfigCheck {
  ok: boolean;
  repaired?: boolean;
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
  const logDir = path.join(getProjectDir(), "scripts", "logs");
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
 * Cleans up stale dispatches on startup.
 * Marks any `running` dispatches older than 2x the configured timeout as `failed`.
 * Also checks if the PID is still alive — if not, marks as `failed` immediately.
 */
export function cleanupStaleDispatches(): { cleaned: number } {
  const db = getDb();
  const timeoutMs = getDispatchTimeoutMs();
  const staleThresholdSeconds = Math.round((timeoutMs * 2) / 1000);

  // Mark dispatches older than 2x timeout as failed
  const staleByAge = db.prepare(`
    UPDATE dispatches SET status = 'failed', completed_at = datetime('now')
    WHERE status = 'running'
      AND created_at < datetime('now', '-' || ? || ' seconds')
  `).run(staleThresholdSeconds);

  // Check remaining running dispatches for dead PIDs
  const stillRunning = db.prepare(
    "SELECT id, pid FROM dispatches WHERE status = 'running'"
  ).all() as { id: number; pid: number }[];

  let deadPidCount = 0;
  for (const d of stillRunning) {
    try {
      process.kill(d.pid, 0); // signal 0 = check if alive
    } catch {
      db.prepare(
        "UPDATE dispatches SET status = 'failed', completed_at = datetime('now') WHERE id = ?"
      ).run(d.id);
      deadPidCount++;
    }
  }

  const cleaned = (staleByAge.changes ?? 0) + deadPidCount;
  if (cleaned > 0) {
    logToFile("stale_dispatch_cleanup", { cleaned, stale_by_age: staleByAge.changes ?? 0, dead_pids: deadPidCount });
  }
  return { cleaned };
}

/**
 * Validates that the target engine's MCP config exists and contains the agent-collab entry.
 * If the config file is missing entirely, attempts to auto-repair by writing it from templates.
 */
export function validateMcpConfig(target: "claude-code" | "cursor"): McpConfigCheck {
  const cwd = getProjectDir();

  if (target === "claude-code") {
    const configPath = path.join(cwd, ".claude", "settings.json");
    return checkAndRepairConfig(configPath, target);
  } else {
    const configPath = path.join(cwd, ".cursor", "mcp.json");
    return checkAndRepairConfig(configPath, target);
  }
}

function checkAndRepairConfig(configPath: string, target: "claude-code" | "cursor"): McpConfigCheck {
  if (!fs.existsSync(configPath)) {
    const repaired = tryWriteConfig(configPath, target);
    if (repaired) {
      logToFile("mcp_config_repaired", { target, path: configPath, action: "created" });
      return { ok: true, repaired: true };
    }
    return {
      ok: false,
      reason: `${configPath} not found. Call setup_project(engine_mode="both") to create it, or switch to cursor-only mode.`,
    };
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    if (content.includes("agent-collab")) {
      return { ok: true };
    }

    const merged = mergeAgentCollabEntry(configPath, target);
    if (merged) {
      logToFile("mcp_config_repaired", { target, path: configPath, action: "merged" });
      return { ok: true, repaired: true };
    }

    return {
      ok: false,
      reason: `${configPath} exists but does not contain agent-collab MCP entry. Call setup_project(engine_mode="both") to repair it.`,
    };
  } catch {
    return {
      ok: false,
      reason: `Cannot read ${configPath}. Call setup_project(engine_mode="both") to recreate it.`,
    };
  }
}

function getAgentCollabServerEntry(target: "claude-code" | "cursor"): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "agent-collab-mcp@latest"],
    env: { AGENT_ROLE: target === "claude-code" ? "claude-code" : "cursor", AGENT_ENGINE_MODE: "both" },
  };
}

function tryWriteConfig(configPath: string, target: "claude-code" | "cursor"): boolean {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    if (target === "claude-code") {
      const config = {
        permissions: { allow: ["mcp__agent-collab__*", "Read(*)", "Grep(*)", "Write(*)", "Edit(*)"] },
        mcpServers: { "agent-collab": getAgentCollabServerEntry(target) },
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    } else {
      const config = {
        mcpServers: { "agent-collab": getAgentCollabServerEntry(target) },
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}

function mergeAgentCollabEntry(configPath: string, target: "claude-code" | "cursor"): boolean {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers["agent-collab"] = getAgentCollabServerEntry(target);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Watchdog: polls the DB for expected state changes after dispatch.
 * Kills the process if no progress is detected within the timeout.
 */
function startWatchdog(
  child: ChildProcess,
  dispatchId: number,
  expectation: { countQuery: string; initialCount: number },
  timeoutMs: number
): void {
  const interval = 30_000;
  const start = Date.now();

  function check(): boolean {
    const elapsed = Date.now() - start;

    // Check if process is still alive
    try { process.kill(child.pid!, 0); } catch {
      completeDispatch(dispatchId, "completed");
      logToFile("dispatch_completed", { dispatch_id: dispatchId, elapsed_ms: elapsed });
      return true; // done
    }

    // Check for DB progress
    try {
      const db = getDb();
      const row = db.prepare(expectation.countQuery).get() as { cnt: number };
      if (row.cnt > expectation.initialCount) {
        completeDispatch(dispatchId, "completed");
        logToFile("dispatch_progress_detected", { dispatch_id: dispatchId, elapsed_ms: elapsed });
        return true; // done
      }
    } catch { /* DB read failure, keep polling */ }

    // Check timeout
    if (elapsed >= timeoutMs) {
      try { process.kill(child.pid!, "SIGTERM"); } catch { /* already dead */ }
      completeDispatch(dispatchId, "timeout");
      const role = getRole();
      const db = getDb();
      db.prepare("INSERT INTO activity_log (agent, action) VALUES (?, ?)").run(
        role,
        `Watchdog killed dispatch ${dispatchId} (PID ${child.pid}) after ${Math.round(elapsed / 1000)}s timeout`
      );
      logToFile("dispatch_timeout", { dispatch_id: dispatchId, pid: child.pid, elapsed_ms: elapsed });
      return true; // done
    }

    return false; // keep polling
  }

  // Immediate first check — detect already-dead processes before first interval tick
  setTimeout(() => {
    if (check()) return;

    const timer = setInterval(() => {
      if (check()) clearInterval(timer);
    }, interval);
    timer.unref();
  }, 1000).unref();
}

const NEGATIVE_CONSTRAINTS = [
  "Do NOT write, create, or edit any files.",
  "Do NOT use Bash, shell commands, or scripts.",
  "Do NOT use the Write, Edit, or Bash tools.",
  "Use ONLY MCP tools from the agent-collab server for all actions.",
].join(" ");

/**
 * Determine which engine a dispatch targets, based on current role, target type, and strategy.
 * For most strategies, reviewer dispatches go to the opposite engine.
 * For parallel-specialist (where both agents can review), reviewer dispatches
 * also go to the opposite engine for cross-review.
 */
function resolveDispatchTarget(target: "reviewer" | "builder"): "claude-code" | "cursor" {
  const myRole = getRole();
  // Always dispatch to the opposite engine — this is correct for all strategies:
  // - architect-builder: cursor(builder) → claude-code(reviewer), claude-code(architect) → cursor(builder)
  // - parallel-specialist: cross-review goes to opposite engine
  if (target === "reviewer") {
    return myRole === "cursor" ? "claude-code" : "cursor";
  }
  return myRole === "claude-code" ? "cursor" : "claude-code";
}

/**
 * Spawns a CLI agent as a detached background process.
 * Validates MCP config before spawning, auto-repairs if possible.
 * Returns immediately — the child runs independently.
 */
export function dispatchAgent(
  target: "reviewer" | "builder",
  prompt: string,
  watchdogQuery?: { countQuery: string; initialCount: number }
): DispatchResult {
  const mode = getEngineMode();
  const myRole = getRole();

  if (isSingleEngine()) {
    return { dispatched: false, reason: "Single-engine mode — no counterpart to dispatch." };
  }

  const dispatchTarget = resolveDispatchTarget(target);
  const configCheck = validateMcpConfig(dispatchTarget);
  if (!configCheck.ok) {
    return { dispatched: false, reason: configCheck.reason };
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
    cwd: getProjectDir(),
  });

  child.unref();
  const pid = child.pid ?? 0;
  const relLogFile = path.relative(getProjectDir(), logFile);

  fs.writeSync(out, `--- Dispatched: ${cmd} ${args.join(" ")}\n--- PID: ${pid}\n--- Time: ${new Date().toISOString()}\n---\n`);

  const db = getDb();
  db.prepare(
    "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
  ).run(getRole(), `Dispatched ${target} (PID ${pid}, log: ${path.basename(logFile)})${configCheck.repaired ? " [MCP config auto-repaired]" : ""}`);

  const dispatchId = recordDispatch(pid, target, relLogFile);
  logToFile("dispatch_started", { dispatch_id: dispatchId, target, pid, cmd, log_file: relLogFile, config_repaired: configCheck.repaired ?? false });

  child.on("error", (err) => {
    completeDispatch(dispatchId, "failed");
    logToFile("dispatch_spawn_error", { dispatch_id: dispatchId, error: err.message });
  });

  if (watchdogQuery) {
    startWatchdog(child, dispatchId, watchdogQuery, getDispatchTimeoutMs());
  }

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

  const db = getDb();
  const reviewCount = (db.prepare("SELECT COUNT(*) as cnt FROM reviews").get() as { cnt: number }).cnt;

  return dispatchAgent("reviewer", prompt, {
    countQuery: "SELECT COUNT(*) as cnt FROM reviews",
    initialCount: reviewCount,
  });
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

  const db = getDb();
  const inProgressCount = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'in-progress'").get() as { cnt: number }).cnt;

  return dispatchAgent("builder", prompt, {
    countQuery: "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'in-progress'",
    initialCount: inProgressCount,
  });
}

export function dispatchArchitect(userRequest: string): DispatchResult {
  if (isSingleEngine()) {
    return { dispatched: false, reason: "Single-engine mode — you are the architect. Create the HLD and tasks yourself." };
  }

  const prompt = `Call get_my_status from the agent-collab MCP. You are the Architect. Create an HLD with set_context("hld", ...) and then break the work into tasks with create_task. Set notify_builder=true on the LAST create_task call. ${NEGATIVE_CONSTRAINTS} The user wants: ${userRequest}`;

  const db = getDb();
  const taskCount = (db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as { cnt: number }).cnt;

  return dispatchAgent("reviewer", prompt, {
    countQuery: "SELECT COUNT(*) as cnt FROM tasks",
    initialCount: taskCount,
  });
}

function formatResult(r: DispatchResult): string {
  if (r.dispatched) {
    return `Dispatched (PID: ${r.pid}, log: ${r.logFile})`;
  }
  return `Not dispatched: ${r.reason}`;
}

export { formatResult };
