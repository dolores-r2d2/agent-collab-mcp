import { describe, it, expect } from "vitest";
import { getAllStrategies, getStrategyDef, getDefaultStrategyId, mergeRoleConfigs, mergeToolAccess } from "../strategies.js";

describe("strategies", () => {
  it("should have 6 strategies", () => {
    expect(getAllStrategies()).toHaveLength(6);
  });

  it("each strategy should have primary and secondary roles", () => {
    for (const s of getAllStrategies()) {
      expect(s.roles.primary).toBeDefined();
      expect(s.roles.secondary).toBeDefined();
      expect(s.roles.primary.name).toBeTruthy();
      expect(s.roles.secondary.name).toBeTruthy();
      expect(s.roles.primary.instructions).toBeTruthy();
      expect(s.roles.secondary.instructions).toBeTruthy();
    }
  });

  it("default strategy should be architect-builder", () => {
    expect(getDefaultStrategyId()).toBe("architect-builder");
    const def = getStrategyDef("architect-builder");
    expect(def).toBeDefined();
    expect(def!.roles.primary.name).toBe("Builder");
  });

  it("getStrategyDef returns undefined for unknown", () => {
    expect(getStrategyDef("nonexistent")).toBeUndefined();
  });

  it("mergeToolAccess ORs all booleans", () => {
    const a = { task_create: true, task_claim: false, task_submit: false, review_write: false, context_write: true, save_plan: false };
    const b = { task_create: false, task_claim: true, task_submit: true, review_write: true, context_write: false, save_plan: true };
    const merged = mergeToolAccess(a, b);
    expect(merged.task_create).toBe(true);
    expect(merged.task_claim).toBe(true);
    expect(merged.task_submit).toBe(true);
    expect(merged.review_write).toBe(true);
    expect(merged.context_write).toBe(true);
    expect(merged.save_plan).toBe(true);
  });

  it("mergeRoleConfigs combines names and instructions", () => {
    const primary = { name: "Builder", description: "Builds", instructions: "Build things", tools: { task_create: false, task_claim: true, task_submit: true, review_write: false, context_write: false, save_plan: true } };
    const secondary = { name: "Reviewer", description: "Reviews", instructions: "Review things", tools: { task_create: true, task_claim: false, task_submit: false, review_write: true, context_write: true, save_plan: false } };
    const merged = mergeRoleConfigs(primary, secondary);
    expect(merged.name).toContain("Builder");
    expect(merged.name).toContain("Reviewer");
    expect(merged.tools.task_create).toBe(true);
    expect(merged.tools.task_claim).toBe(true);
    expect(merged.tools.review_write).toBe(true);
  });
});
