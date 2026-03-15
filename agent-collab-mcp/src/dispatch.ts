/**
 * Cross-agent dispatch module.
 * Spawns counterpart agent CLIs as detached background processes
 * so the MCP server can orchestrate without human intervention.
 */

import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { getEngineMode, getRole, getDb, isSingleEngine } from "./db.js";

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

/**
 * Spawns a CLI agent as a detached background process.
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
      args = ["-p", "--permission-mode", "auto", prompt];
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
      args = ["-p", "--permission-mode", "auto", prompt];
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

  fs.writeSync(out, `--- Dispatched: ${cmd} ${args.join(" ")}\n--- PID: ${pid}\n--- Time: ${new Date().toISOString()}\n---\n`);

  const db = getDb();
  db.prepare(
    "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
  ).run(getRole(), `Dispatched ${target} (PID ${pid}, log: ${path.basename(logFile)})`);

  return {
    dispatched: true,
    pid,
    logFile: path.relative(process.cwd(), logFile),
  };
}

export function dispatchReview(taskIds: string[]): DispatchResult {
  const idList = taskIds.join(", ");
  const prompt = taskIds.length === 1
    ? `Call get_my_status from the agent-collab MCP. Then get_task("${taskIds[0]}") to read details. Review the implementation files and call review_task with your verdict.`
    : `Call get_my_status from the agent-collab MCP. You have ${taskIds.length} tasks to review: ${idList}. For each, call get_task, review the files, then review_task with your verdict.`;

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
  const mode = getEngineMode();

  if (isSingleEngine()) {
    return { dispatched: false, reason: "Single-engine mode — you are the architect. Create the HLD and tasks yourself." };
  }

  if (!cliExists("claude")) {
    return { dispatched: false, reason: "claude CLI not found on PATH. Install Claude Code CLI or create tasks manually." };
  }

  const prompt = `Call get_my_status from the agent-collab MCP. You are the Architect. Create an HLD with set_context("hld", ...) and then break the work into tasks with create_task. Set notify_builder=true on the LAST create_task call. The user wants: ${userRequest}`;

  const logDir = ensureLogDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logDir, `dispatch-architect-${ts}.log`);
  const out = fs.openSync(logFile, "w");

  const child = spawn("claude", ["-p", "--permission-mode", "auto", prompt], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: process.cwd(),
  });

  child.unref();
  const pid = child.pid ?? 0;

  fs.writeSync(out, `--- Dispatched architect: claude -p ...\n--- PID: ${pid}\n--- Time: ${new Date().toISOString()}\n--- Request: ${userRequest}\n---\n`);

  const db = getDb();
  db.prepare(
    "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
  ).run(getRole(), `Invoked architect for: ${userRequest.slice(0, 100)} (PID ${pid})`);

  return {
    dispatched: true,
    pid,
    logFile: path.relative(process.cwd(), logFile),
  };
}

function formatResult(r: DispatchResult): string {
  if (r.dispatched) {
    return `Dispatched (PID: ${r.pid}, log: ${r.logFile})`;
  }
  return `Not dispatched: ${r.reason}`;
}

export { formatResult };
