import type { Issue } from "./types.js";

export function parseIssues(issuesJson: string | null): Issue[] {
  if (!issuesJson) return [];
  try {
    return JSON.parse(issuesJson) as Issue[];
  } catch {
    return [{ description: issuesJson }];
  }
}

export function formatIssuesList(issues: Issue[]): string {
  return issues.map(i =>
    `  - [${i.file || "general"}${i.line ? ":" + i.line : ""}] ${i.description}`
  ).join("\n");
}
