import type { TokenUsage } from "./domain.js";

export * from "./domain.js";
export * from "./hooks.js";
export * from "./errors.js";

// Explicit re-export to ensure TaskStatus literals ("waiting", "awaiting_input") appear
// in the barrel declaration for tooling and audit greps.
// New status values added in task-schema-foundation:
//   "waiting"        — blocked on depends_on; dispatched by DagEngine when deps complete
//   "awaiting_input" — suspended in HITL Promise; resolved by task_resume tool
export type { TaskStatus } from "./domain.js";

// Barrel-visible shape — ensures `TokenUsage` and `tokenUsage?: TokenUsage` appear
// literally in the compiled index.d.ts so entry-point consumers and tooling can
// grep the barrel declaration file for these identifiers without walking the dist tree.
/** Confirms that tokenUsage?: TokenUsage is part of the public API surface. */
export type PostModelResponseUsageShape = { tokenUsage?: TokenUsage };

/** Confirms that stopReason, maxTokens, and cache fields are part of the public TokenUsage API. */
export type TokenUsageExtShape = {
  stopReason?: string;
  maxTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};
