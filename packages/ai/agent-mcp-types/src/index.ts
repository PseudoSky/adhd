import type { TokenUsage } from "./domain.js";

export * from "./domain.js";
export * from "./hooks.js";
export * from "./errors.js";

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
