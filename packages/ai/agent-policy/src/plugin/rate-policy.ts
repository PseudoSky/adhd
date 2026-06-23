/**
 * rate-policy.ts — pure helper for evaluating rate-policy limits.
 *
 * Stateless: given an effective rules object and a current model-call count,
 * decides whether the limit is crossed and returns the enforcement error payload.
 * Unit-testable independent of hook wiring.
 */

import type { IEnforcementError } from "@adhd/agent-mcp-types";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The effective rules for a `rate`-type policy after shallow-merging
 * `template.rules` with `override_config` (Decision 3 in decisions.md).
 *
 * All limits are optional; a missing key means "no limit enforced."
 */
export interface RatePolicyRules {
    /** Max number of model (LLM) calls per task. */
    maxModelCalls?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an IEnforcementError for a rate-policy violation.
 * Code is "POLICY_VIOLATION" (distinct from budget plugin's "BUDGET_EXCEEDED"
 * so the orchestrator can distinguish enforcement source).
 */
export function makeRatePolicyError(
    limitName: string,
    limit: number,
    current: number
): IEnforcementError {
    return {
        isEnforcementError: true as const,
        code: "POLICY_VIOLATION",
        message: `POLICY_VIOLATION: rate policy ${limitName} limit is ${limit}, current value is ${current}`,
    };
}

/**
 * Evaluate whether the given `modelCalls` count violates the effective rules.
 *
 * Returns an IEnforcementError to throw, or `null` when within limits.
 * Pure function: no side effects, deterministic.
 */
export function evaluateRatePolicy(
    rules: RatePolicyRules,
    modelCalls: number
): IEnforcementError | null {
    if (
        rules.maxModelCalls !== undefined &&
        modelCalls >= rules.maxModelCalls
    ) {
        return makeRatePolicyError("maxModelCalls", rules.maxModelCalls, modelCalls);
    }
    return null;
}
