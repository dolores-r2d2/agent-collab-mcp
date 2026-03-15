/**
 * Collaboration strategies define how two agents divide responsibilities.
 * Strategies are ENGINE-AGNOSTIC — they define "primary" and "secondary" roles,
 * not specific engines. The engine_mode config maps physical engines to roles.
 *
 * Research basis:
 * - CooperBench (2026): Structured handoffs >> freeform dialogue
 * - MetaGPT: SOP-based role assignment with document exchange
 * - Zylos Research: Role specialization patterns that mirror human teams
 * - Google 8 Patterns: Supervisor, Sequential, Parallel, Reflection, etc.
 * - Anthropic Agentic Coding Report: Plan/Execute split, Writer/Reviewer loop
 */

export interface ToolAccess {
  task_create: boolean;
  task_claim: boolean;
  task_submit: boolean;
  review_write: boolean;
  context_write: boolean;
  save_plan: boolean;
}

export interface RoleConfig {
  name: string;
  description: string;
  instructions: string;
  tools: ToolAccess;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  best_for: string;
  research_basis: string;
  roles: {
    primary: RoleConfig;
    secondary: RoleConfig;
  };
}

export type EngineMode = "both" | "cursor-only" | "claude-code-only";

export function mergeToolAccess(a: ToolAccess, b: ToolAccess): ToolAccess {
  return {
    task_create: a.task_create || b.task_create,
    task_claim: a.task_claim || b.task_claim,
    task_submit: a.task_submit || b.task_submit,
    review_write: a.review_write || b.review_write,
    context_write: a.context_write || b.context_write,
    save_plan: a.save_plan || b.save_plan,
  };
}

export function mergeRoleConfigs(primary: RoleConfig, secondary: RoleConfig): RoleConfig {
  return {
    name: `${primary.name} + ${secondary.name}`,
    description: `You handle both roles. Primary: ${primary.description} Secondary: ${secondary.description}`,
    instructions: `You handle BOTH roles in this workflow.\n\nAs ${primary.name}: ${primary.instructions}\n\nAs ${secondary.name}: ${secondary.instructions}`,
    tools: mergeToolAccess(primary.tools, secondary.tools),
  };
}

const STRATEGIES: Record<string, Strategy> = {

  "architect-builder": {
    id: "architect-builder",
    name: "Architect–Builder",
    description: "One agent designs the architecture and reviews. The other implements. The classic separation: thinking vs doing.",
    best_for: "Greenfield projects, well-defined features, teams wanting clear separation of design and implementation.",
    research_basis: "Standard software engineering separation of concerns. MetaGPT's SOP-based role assignment shows structured handoffs outperform dialogue-based approaches (85.9% Pass@1). Anthropic's Plan/Execute split: use stronger model for planning, faster model for execution.",
    roles: {
      primary: {
        name: "Builder",
        description: "Implements features based on task specs. Claims tasks, writes plans, codes, submits for review.",
        instructions: `You are the Builder. Before ANY work, call get_my_status. Do NOT write code without claiming a task first via claim_task. After finishing, call submit_for_review. Workflow: get_my_status → claim_task → get_task → save_plan → [implement] → submit_for_review.`,
        tools: { task_create: false, task_claim: true, task_submit: true, review_write: false, context_write: false, save_plan: true },
      },
      secondary: {
        name: "Architect / Reviewer",
        description: "Designs the HLD, creates tasks with detailed specs, reviews completed implementations.",
        instructions: `You are the Architect and Reviewer. Call get_my_status first. Create an HLD with set_context, break it into tasks with create_task. When tasks are in review, read the code and call review_task. Workflow: get_my_status → set_context → create_task / review_task.`,
        tools: { task_create: true, task_claim: false, task_submit: false, review_write: true, context_write: true, save_plan: false },
      },
    },
  },

  "tdd-red-green": {
    id: "tdd-red-green",
    name: "TDD Red–Green",
    description: "One agent writes failing tests first (Red). The other makes them pass (Green). The first agent reviews coverage and quality.",
    best_for: "Bug-prone domains, APIs, data processing, anything where correctness matters more than speed.",
    research_basis: "TDD-on-autopilot pattern: tests as machine-verifiable specs transform AI from code generator requiring QA into one that self-validates. Developer Toolkit research shows this is the highest-leverage technique for reliable AI output. Anthropic's Writer/Reviewer loop adapted for test-first methodology.",
    roles: {
      primary: {
        name: "Implementer (Green)",
        description: "Makes failing tests pass. Claims tasks that include test files, implements code until all tests are green, then submits.",
        instructions: `You are the Implementer in a TDD workflow. Call get_my_status first. Each task includes failing test files that define the expected behavior. Your job: claim the task, read the tests, implement code to make them pass, verify with the test runner, then submit_for_review. Do NOT modify the test files — only write implementation code. Workflow: get_my_status → claim_task → get_task → [read tests, implement, run tests] → submit_for_review.`,
        tools: { task_create: false, task_claim: true, task_submit: true, review_write: false, context_write: false, save_plan: true },
      },
      secondary: {
        name: "Test Author / Reviewer (Red)",
        description: "Writes failing tests as task specs, then reviews implementations for coverage, edge cases, and code quality.",
        instructions: `You are the Test Author and Reviewer in a TDD workflow. Call get_my_status first. When creating tasks: write the failing test files FIRST and include them in the task context. The test files ARE the specification — they define exactly what "done" means. When reviewing: verify all tests pass, check edge case coverage, assess code quality. If tests are insufficient, add more tests in the review. Workflow: get_my_status → set_context → create_task (include test file paths/content) / review_task.`,
        tools: { task_create: true, task_claim: false, task_submit: false, review_write: true, context_write: true, save_plan: false },
      },
    },
  },

  "writer-reviewer": {
    id: "writer-reviewer",
    name: "Writer–Reviewer (Critique Loop)",
    description: "One agent generates code. The other critiques from multiple perspectives (security, performance, correctness). Iterates until converged.",
    best_for: "High-quality code where review depth matters. Security-sensitive features. Performance-critical paths. Production-grade APIs.",
    research_basis: "Constitutional AI / debate patterns. Zylos Research: Writer/Reviewer loop consistently delivers quality improvements — Agent A writes, Agent B critiques, Agent A incorporates feedback, loop until approval. Google ADK formalizes this with LoopAgents. Devin's PR merge rate improved from 34% to 67% with iterative automated review.",
    roles: {
      primary: {
        name: "Writer / Generator",
        description: "Writes code, incorporates critique, iterates until the reviewer approves. Focuses on producing clean, correct implementations.",
        instructions: `You are the Writer in a critique-loop workflow. Call get_my_status first. Write your best implementation, then submit for review. When you get feedback (changes-requested), treat every issue as mandatory — address each one, re-claim the task, fix, and resubmit. Expect multiple review rounds; this is by design, not failure. Workflow: get_my_status → claim_task → [implement] → submit_for_review → [if feedback] claim_task → [fix] → submit_for_review.`,
        tools: { task_create: false, task_claim: true, task_submit: true, review_write: false, context_write: false, save_plan: true },
      },
      secondary: {
        name: "Multi-Perspective Critic",
        description: "Reviews from multiple angles: correctness, security, performance, test coverage, maintainability. Provides detailed, actionable critique each round.",
        instructions: `You are the Critic in a critique-loop workflow. Call get_my_status first. When reviewing, analyze from ALL perspectives: (1) Correctness — does it meet acceptance criteria? (2) Security — injection, auth, data exposure? (3) Performance — N+1 queries, unnecessary allocations, algorithmic complexity? (4) Test coverage — edge cases, error paths? (5) Maintainability — naming, abstractions, coupling? Be thorough but fair. Approve only when all perspectives pass. Use severity levels: critical blocks approval, warning requires justification, note is advisory. Workflow: get_my_status → create_task / review_task (multi-perspective).`,
        tools: { task_create: true, task_claim: false, task_submit: false, review_write: true, context_write: true, save_plan: false },
      },
    },
  },

  "parallel-specialist": {
    id: "parallel-specialist",
    name: "Parallel Specialists (Domain Split)",
    description: "Each agent owns a domain (e.g., frontend/backend, API/data). Both create and implement tasks in their domain. Cross-review each other's work.",
    best_for: "Full-stack features. Microservice architectures. Projects with clear domain boundaries.",
    research_basis: "Google's Parallel Pattern: agents work simultaneously on distinct slices. Gas Town manages 20-30 parallel agents across 7 roles. CooperBench shows near-linear speedup when tasks are truly independent. File reservation (assign different directories) prevents conflicts — a key best practice from Claude Code Agent Teams.",
    roles: {
      primary: {
        name: "Specialist A",
        description: "Owns one domain. Creates and implements tasks in that domain. Reviews the other specialist's work from a consumer/integration perspective.",
        instructions: `You are Specialist A. Call get_my_status first. You can create tasks in your domain AND claim/implement tasks assigned to you. When reviewing the other specialist's work, focus on: interface contracts, error handling, and integration correctness from your domain's perspective. Workflow: get_my_status → create_task (your domain) / claim_task → [implement] → submit_for_review. Also: review_task (for the other domain's tasks).`,
        tools: { task_create: true, task_claim: true, task_submit: true, review_write: true, context_write: false, save_plan: true },
      },
      secondary: {
        name: "Specialist B",
        description: "Owns the other domain. Creates and implements tasks in that domain. Reviews Specialist A's work from an API/data perspective.",
        instructions: `You are Specialist B. Call get_my_status first. You can create tasks in your domain AND implement them yourself. When reviewing Specialist A's work, focus on: correct usage of shared interfaces, proper error handling, data validation, state management. Set the HLD and domain boundaries with set_context. Workflow: get_my_status → set_context → create_task (your domain) / claim_task → [implement] → submit_for_review. Also: review_task (for the other domain's tasks).`,
        tools: { task_create: true, task_claim: true, task_submit: true, review_write: true, context_write: true, save_plan: true },
      },
    },
  },

  "planner-executor": {
    id: "planner-executor",
    name: "Planner–Executor",
    description: "One agent produces extremely detailed plans (pseudocode, interface contracts, file-by-file specs). The other executes mechanically.",
    best_for: "Complex systems, junior-level execution, when you want maximum control over architecture. Large refactors where consistency matters.",
    research_basis: "Anthropic's Plan/Execute split: use more capable model for decomposition, faster/cheaper model for execution — optimizes cost while maintaining architectural quality. Zylos Research: hierarchical decomposition completes complex tasks 58% faster with 34% higher completion rates vs flat approaches. Karpathy's agentic engineering: the discipline of designing systems where specifications drive execution.",
    roles: {
      primary: {
        name: "Executor",
        description: "Follows detailed plans mechanically. Implements exactly as specified — pseudocode becomes real code. Asks for clarification rather than improvising.",
        instructions: `You are the Executor. Call get_my_status first. Each task contains a highly detailed plan with pseudocode, file paths, interface contracts, and exact specifications. Your job: translate the plan into working code EXACTLY as specified. Do NOT deviate from the plan. If the plan is ambiguous, use log_activity to flag it and ask for clarification rather than guessing. Workflow: get_my_status → claim_task → get_task → [implement per plan] → submit_for_review.`,
        tools: { task_create: false, task_claim: true, task_submit: true, review_write: false, context_write: false, save_plan: false },
      },
      secondary: {
        name: "Planner / Specifier",
        description: "Creates exhaustively detailed task specs: pseudocode, interface contracts, file-by-file instructions, exact function signatures. Reviews for spec conformance.",
        instructions: `You are the Planner. Call get_my_status first. Your task specs must be exhaustively detailed — the Executor should never need to make architectural decisions. For each task include: (1) Exact file paths to create/modify (2) Interface contracts and type signatures (3) Pseudocode or step-by-step implementation instructions (4) Edge cases to handle (5) Test expectations. When reviewing, verify the implementation matches your spec exactly. Workflow: get_my_status → set_context → create_task (with detailed specs) / review_task (spec conformance).`,
        tools: { task_create: true, task_claim: false, task_submit: false, review_write: true, context_write: true, save_plan: false },
      },
    },
  },

  "sequential-pipeline": {
    id: "sequential-pipeline",
    name: "Sequential Quality Pipeline",
    description: "One agent implements. The other runs a multi-stage quality pipeline: security scan, performance review, test coverage, architecture review, final verdict.",
    best_for: "Enterprise/production code. Security-critical applications. Teams that want rigorous, multi-pass quality assurance.",
    research_basis: "Google's Sequential Pattern: output of one stage feeds the next in a quality pipeline. Zylos Research: multi-perspective review with specialized reviewers outperforms single-pass review. Claude Code Agent Teams enable parallel review with role specialization — spawning reviewers focused on security, performance, and test coverage. Augment Code: generate-review-fix cycle iterates until convergence.",
    roles: {
      primary: {
        name: "Implementer",
        description: "Implements features and iterates on multi-stage review feedback. Each review round may focus on a different quality dimension.",
        instructions: `You are the Implementer in a quality pipeline. Call get_my_status first. After submitting, your code goes through a multi-stage review pipeline (security → performance → tests → architecture). Each review round may have issues from a DIFFERENT quality perspective. Address all issues for the current stage, then resubmit. You'll iterate until all pipeline stages approve. Workflow: get_my_status → claim_task → [implement] → submit_for_review → [address stage feedback] → submit_for_review → [repeat per stage].`,
        tools: { task_create: false, task_claim: true, task_submit: true, review_write: false, context_write: false, save_plan: true },
      },
      secondary: {
        name: "Quality Pipeline Manager",
        description: "Runs a multi-stage review pipeline. Each review round focuses on a different quality dimension. Only approves when all stages pass.",
        instructions: `You are the Quality Pipeline Manager. Call get_my_status first. When reviewing, run a multi-stage pipeline. Check which review round this is for the task:
Round 1 — SECURITY: injection, auth, data exposure, secrets, input validation.
Round 2 — PERFORMANCE: N+1 queries, memory leaks, algorithmic complexity, caching.
Round 3 — TEST COVERAGE: edge cases, error paths, integration scenarios.
Round 4 — ARCHITECTURE: naming, abstractions, coupling, consistency with HLD.
If the current stage has issues, set verdict to changes-requested with the stage name in notes. Only approve on the final stage if all look good. Each stage that passes should be noted so you don't re-check it. Workflow: get_my_status → create_task / review_task (stage-by-stage).`,
        tools: { task_create: true, task_claim: false, task_submit: false, review_write: true, context_write: true, save_plan: false },
      },
    },
  },
};

export function getStrategyDef(id: string): Strategy | undefined {
  return STRATEGIES[id];
}

export function getAllStrategies(): Strategy[] {
  return Object.values(STRATEGIES);
}

export function getDefaultStrategyId(): string {
  return "architect-builder";
}
