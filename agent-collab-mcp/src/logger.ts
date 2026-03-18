/**
 * Structured activity log to file.
 * Emits tab-separated log lines for offline analysis and CI integration.
 * Complements the SQLite activity_log table.
 */

import fs from "fs";
import path from "path";
import { getProjectDir } from "./db.js";

const LOG_DIR = path.join("scripts", "logs");
const LOG_FILE = path.join(LOG_DIR, "activity.log");

function ensureLogDir(): void {
  fs.mkdirSync(path.join(getProjectDir(), LOG_DIR), { recursive: true });
}

export function logToFile(action: string, data: Record<string, unknown> = {}): void {
  try {
    ensureLogDir();
    const ts = new Date().toISOString();
    const kvPairs = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\t");
    const line = `${ts}\t${action}\t${kvPairs}\n`;
    fs.appendFileSync(path.join(getProjectDir(), LOG_FILE), line);
  } catch {
    // Best-effort logging — never crash the MCP server
  }
}
