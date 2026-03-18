import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole, getToolAccess } from "../db.js";
import { NOT_SETUP, err } from "../errors.js";
import type { ContextRow } from "../types.js";

export function registerContextTools(server: McpServer): void {
  server.tool(
    "get_context",
    "Get a project context document (PRD or HLD summary).",
    { key: z.enum(["prd", "hld"]).describe("Document key: 'prd' or 'hld'") },
    async ({ key }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const row = db.prepare("SELECT content, updated_at, version, updated_by FROM context_docs WHERE key = ?").get(key) as (ContextRow & { version?: number; updated_by?: string }) | undefined;

      if (!row) {
        const canWrite = getToolAccess().context_write;
        const hint = canWrite
          ? `Create one with set_context("${key}", ...).`
          : "The other agent needs to create one first.";
        return err("NOT_FOUND", `No ${key.toUpperCase()} document found. ${hint}`);
      }

      const versionInfo = row.version ? ` v${row.version}` : "";
      const byInfo = row.updated_by ? ` by ${row.updated_by}` : "";
      return { content: [{ type: "text", text: `${key.toUpperCase()}${versionInfo} (updated ${row.updated_at}${byInfo}):\n\n${row.content}` }] };
    }
  );

  server.tool(
    "set_context",
    "Create or update a project context document (PRD or HLD).",
    {
      key: z.enum(["prd", "hld"]).describe("Document key: 'prd' or 'hld'"),
      content: z.string().describe("The document text to save (keep concise, max ~150 lines). This is REQUIRED — pass the full document text here."),
    },
    async ({ key, content }) => {
      if (!isInitialized()) return NOT_SETUP;
      if (!getToolAccess().context_write) return err("NO_ACCESS", "set_context is not available for your current role.");

      const db = getDb();
      const role = getRole();

      // Get current version for incrementing
      const existing = db.prepare("SELECT version FROM context_docs WHERE key = ?").get(key) as { version?: number } | undefined;
      const newVersion = (existing?.version ?? 0) + 1;

      db.prepare(`
        INSERT INTO context_docs (key, content, version, updated_by, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET content = excluded.content, version = ?, updated_by = ?, updated_at = datetime('now')
      `).run(key, content, newVersion, role, newVersion, role);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Updated ${key.toUpperCase()} document (v${newVersion})`);

      return { content: [{ type: "text", text: `${key.toUpperCase()} document saved (v${newVersion}).` }] };
    }
  );

  server.tool(
    "log_activity",
    "Log an activity entry.",
    { action: z.string().describe("Short description of what was done") },
    async ({ action }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const role = getRole();
      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, action);

      return { content: [{ type: "text", text: "Logged." }] };
    }
  );
}
