import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInitialized, getDb, getRole, getToolAccess } from "../db.js";

const NOT_SETUP = { content: [{ type: "text" as const, text: "Project not set up. Call setup_project first." }] };

interface ContextRow {
  key: string;
  content: string;
  updated_at: string;
}

export function registerContextTools(server: McpServer): void {
  server.tool(
    "get_context",
    "Get a project context document (PRD or HLD summary).",
    { key: z.enum(["prd", "hld"]).describe("Document key: 'prd' or 'hld'") },
    async ({ key }) => {
      if (!isInitialized()) return NOT_SETUP;
      const db = getDb();
      const row = db.prepare("SELECT content, updated_at FROM context_docs WHERE key = ?").get(key) as ContextRow | undefined;

      if (!row) {
        const canWrite = getToolAccess().context_write;
        const hint = canWrite
          ? `Create one with set_context("${key}", ...).`
          : "The other agent needs to create one first.";
        return { content: [{ type: "text", text: `No ${key.toUpperCase()} document found. ${hint}` }] };
      }

      return { content: [{ type: "text", text: `${key.toUpperCase()} (updated ${row.updated_at}):\n\n${row.content}` }] };
    }
  );

  server.tool(
    "set_context",
    "Create or update a project context document (PRD or HLD).",
    {
      key: z.enum(["prd", "hld"]).describe("Document key: 'prd' or 'hld'"),
      content: z.string().describe("Document content (keep concise, max ~150 lines)"),
    },
    async ({ key, content }) => {
      if (!isInitialized()) return NOT_SETUP;
      if (!getToolAccess().context_write) {
        return { content: [{ type: "text", text: "set_context is not available for your current role." }] };
      }

      const db = getDb();
      const role = getRole();
      db.prepare(`
        INSERT INTO context_docs (key, content, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
      `).run(key, content);

      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, `Updated ${key.toUpperCase()} document`);

      return { content: [{ type: "text", text: `${key.toUpperCase()} document saved.` }] };
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
