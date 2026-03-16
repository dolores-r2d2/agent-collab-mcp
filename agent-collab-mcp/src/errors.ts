export type ErrorCode =
  | "NOT_SETUP"
  | "NO_ACCESS"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "DEPENDENCY_BLOCKED"
  | "SINGLE_ENGINE";

export function err(code: ErrorCode, message: string) {
  return { content: [{ type: "text" as const, text: `[${code}] ${message}` }] };
}

export const NOT_SETUP = err("NOT_SETUP", "Project not set up. Call setup_project first.");
