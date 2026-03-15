import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, getRole, getToolAccess } from "../db.js";

interface ContextRow {
  key: string;
  content: string;
  updated_at: string;
}

export function registerContextTools(server: McpServer): void {
  const access = getToolAccess();
  const role = getRole();

  server.tool(
    "get_context",
    "Get a project context document (PRD or HLD summary).",
    { key: z.enum(["prd", "hld"]).describe("Document key: 'prd' or 'hld'") },
    async ({ key }) => {
      const db = getDb();
      const row = db.prepare("SELECT content, updated_at FROM context_docs WHERE key = ?").get(key) as ContextRow | undefined;

      if (!row) {
        const hint = access.context_write
          ? `Create one with set_context("${key}", ...).`
          : "The other agent needs to create one first.";
        return { content: [{ type: "text", text: `No ${key.toUpperCase()} document found. ${hint}` }] };
      }

      return { content: [{ type: "text", text: `${key.toUpperCase()} (updated ${row.updated_at}):\n\n${row.content}` }] };
    }
  );

  if (access.context_write) {
    server.tool(
      "set_context",
      "Create or update a project context document (PRD or HLD).",
      {
        key: z.enum(["prd", "hld"]).describe("Document key: 'prd' or 'hld'"),
        content: z.string().describe("Document content (keep concise, max ~150 lines)"),
      },
      async ({ key, content }) => {
        const db = getDb();
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
  }

  server.tool(
    "log_activity",
    "Log an activity entry.",
    { action: z.string().describe("Short description of what was done") },
    async ({ action }) => {
      const db = getDb();
      db.prepare(
        "INSERT INTO activity_log (agent, action) VALUES (?, ?)"
      ).run(role, action);

      return { content: [{ type: "text", text: "Logged." }] };
    }
  );
}
