import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { AgentStore } from '@adhd/agent-registry';
import { ModelStore, ModelStoreError } from '@adhd/agent-provider';

// ──────────────────────────────────────────────
// resolveModel — resolve an agent's model_hint to a platform-specific model id.
//
// Reads the agent's `model_hint` from `registry_agents` via AgentStore.read, then
// calls ModelStore.resolveModelId(modelHint, platform) to look up the binding row
// in `provider_model_platform_bindings` for the target platform.
//
// Reuses ModelStore.resolveModelId ([ref:store-read]); does NOT re-implement the
// SQL join or the platform filter.  The platform filter (`WHERE platform = ?`) lives
// exclusively in ModelStore — removing it collapses both platforms to the first
// binding row, which is the [dod.2] negative-control scenario.
//
// Fallback: if the agent has a model_hint but no binding exists for the (hint,
// platform) pair, the canonical model id (the model_hint itself) is returned and the
// decision is recorded in decisions.md.  If the agent has no model_hint, an empty
// string is returned (callers must handle the "no model" case — Decision B of
// decisions.md says the `model:` frontmatter line is OMITTED when model_hint is null).
// ──────────────────────────────────────────────

/**
 * Resolve an agent's `model_hint` to the platform-specific model string.
 *
 * Algorithm:
 *   1. `AgentStore.read(agentSlug)` — fetch the agent row (includes `model_hint`).
 *   2. If `model_hint` is null/empty → return `''` (caller omits `model:` line).
 *   3. `ModelStore.resolveModelId(modelHint, platform)` — reuse the provider's
 *      binding lookup; the platform filter is applied in ModelStore, not here.
 *   4. If no binding row exists → fall back to the canonical id and mark the decision
 *      (see fallback note below).
 *
 * The platform filter is the [dod.2] negative-control invariant: if ModelStore were
 * called without the platform argument, both platforms would resolve to the same id.
 *
 * @param db         - The shared registry Drizzle handle (all table prefixes).
 * @param agentSlug  - Slug of the agent whose model to resolve.
 * @param platform   - Target platform id (e.g. 'claude_code', 'claude_api').
 * @returns Platform-specific model string, or '' if the agent has no model_hint.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveModel(
  db: BetterSQLite3Database<any>,
  agentSlug: string,
  platform: string
): string {
  // Step 1: fetch agent to get model_hint.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentStore = new AgentStore(db as any);
  const agent = agentStore.read(agentSlug);

  const modelHint = agent.modelHint;

  // Step 2: no model_hint — caller omits the model: frontmatter line (Decision B).
  if (!modelHint) {
    return '';
  }

  // Step 3: resolve via ModelStore — the platform filter lives here, not in resolveModel.
  const modelStore = new ModelStore(db);
  try {
    return modelStore.resolveModelId(modelHint, platform);
  } catch (err) {
    if (
      err instanceof ModelStoreError &&
      err.code === 'MODEL_BINDING_NOT_FOUND'
    ) {
      // Step 4: no binding for (modelHint, platform) — fall back to canonical id.
      // Decision: fallback recorded in docs/plan/agent-compiler/decisions.md.
      // The caller still gets a usable (if un-aliased) string; the compile does not
      // fail for a missing binding.
      return modelHint;
    }
    throw err;
  }
}
