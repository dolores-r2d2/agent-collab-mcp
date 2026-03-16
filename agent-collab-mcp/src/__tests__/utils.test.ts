import { describe, it, expect } from "vitest";
import { parseIssues, formatIssuesList } from "../utils.js";

describe("parseIssues", () => {
  it("returns empty array for null", () => {
    expect(parseIssues(null)).toEqual([]);
  });

  it("parses valid JSON issues", () => {
    const json = JSON.stringify([{ file: "src/a.ts", line: 10, description: "Bug", severity: "critical" }]);
    const issues = parseIssues(json);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("src/a.ts");
    expect(issues[0].line).toBe(10);
  });

  it("returns fallback for invalid JSON", () => {
    const issues = parseIssues("not json");
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toBe("not json");
  });
});

describe("formatIssuesList", () => {
  it("formats issues with file and line", () => {
    const result = formatIssuesList([
      { file: "src/a.ts", line: 42, description: "Missing null check" },
      { description: "General issue" },
    ]);
    expect(result).toContain("[src/a.ts:42]");
    expect(result).toContain("[general]");
    expect(result).toContain("Missing null check");
  });
});
