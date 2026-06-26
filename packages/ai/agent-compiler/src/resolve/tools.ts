import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  AgentToolStore,
  BindingStore,
  type ToolPlatformBinding,
} from '@adhd/agent-tool-registry';

// ──────────────────────────────────────────────
// resolveTools — build the platform tools: header for an agent.
//
// Reads the agent's agent_tools grants via AgentToolStore.listForAgent, then
// for each grant looks up the tool_platform_bindings row for the TARGET platform
// via BindingStore.listForPlatform (one query, indexed on platform_id by
// idx_bindings_platform).  Bindings with availability = 'unavailable' are
// dropped (e.g. human_input on claude_api has no built-in HITL — [def:tools-header]).
//
// The lookup is platform-keyed: BindingStore.listForPlatform passes the
// platformId explicitly and the lookup Map is keyed by (tool_name, platform_id)
// — the [dod.1] negative-control "ignore platform, emit canonical names" bites
// exactly here: using the wrong bindings map (or no platform filter) would return
// canonical names, not aliases.
//
// Reuses agent-tool-registry binding resolution via BindingStore ([ref:store-read]);
// does NOT re-implement the SQL query.
//
// Returns an ordered, de-duplicated list of resolved tool records.
// The markdown emitter renders the platformAlias values as the `tools:` line;
// the JSON emitter shapes the structured array (model-and-policy-emit work,
// not this function's concern).
// ──────────────────────────────────────────────

/** A resolved platform alias for one canonical tool grant. */
export interface ResolvedTool {
  /** Canonical tool name (e.g. 'file_read', 'shell_exec'). */
  canonicalName: string;
  /** Platform-specific alias (e.g. 'Read' on claude_code, 'read_file' on claude_api). */
  platformAlias: string;
  /** Availability on this platform: 'available' | 'restricted' | 'requires_permission'. */
  availability: string;
}

/**
 * Resolve an agent's tool grants to ordered, de-duplicated platform aliases.
 *
 * Algorithm:
 *   1. `AgentToolStore.listForAgent(agentSlug)` — fetch all `tool_*` grants.
 *   2. `BindingStore.listForPlatform(platform)` — one platform-keyed query;
 *      index `idx_bindings_platform` makes this O(1) vs. the catalog size.
 *   3. For each grant, look up its binding row in the result set.
 *      - No row → skip (tool has no binding for this platform).
 *      - `availability = 'unavailable'` → drop (e.g. `human_input` on `claude_api`).
 *      - Otherwise → emit `platformToolName` as the resolved alias.
 *
 * The platform filter is applied to BOTH the listForPlatform call AND the
 * Map lookup so the result is always platform-shaped, never canonical-named.
 * This is the invariant the [dod.1] negative-control tests.
 *
 * @param db         - The shared registry Drizzle handle (all table prefixes).
 * @param agentSlug  - Slug of the agent whose tool grants to resolve.
 * @param platform   - Target platform id (e.g. 'claude_code', 'claude_api').
 * @returns Ordered, de-duplicated `ResolvedTool[]` ready for header emission.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveTools(
  db: BetterSQLite3Database<any>,
  agentSlug: string,
  platform: string
): ResolvedTool[] {
  const agentToolStore = new AgentToolStore(db);
  const bindingStore = new BindingStore(db);

  // Step 1: all grants for this agent (tool_* prefix, logical agent_slug key).
  const grants = agentToolStore.listForAgent(agentSlug);

  // Step 2: one platform-keyed query — reuses BindingStore ([ref:store-read]).
  // Index idx_bindings_platform keeps this O(catalog-size), not O(grants).
  const platformBindings: ToolPlatformBinding[] = bindingStore.listForPlatform(platform);

  // Build a Map<canonicalToolName, binding> for O(1) grant lookups.
  // Platform is already baked in — the Map only holds bindings for THIS platform.
  const bindingByTool = new Map<string, ToolPlatformBinding>(
    platformBindings.map(b => [b.toolName, b])
  );

  // Step 3: walk grants in their stored order; de-duplicate by canonical name.
  const seen = new Set<string>();
  const results: ResolvedTool[] = [];

  for (const grant of grants) {
    if (seen.has(grant.toolName)) {
      continue; // de-duplicate (should not occur with a well-formed DB, but defensive)
    }
    seen.add(grant.toolName);

    const binding = bindingByTool.get(grant.toolName);

    if (!binding) {
      // No binding row for this tool on this platform — skip silently.
      continue;
    }

    if (binding.availability === 'unavailable') {
      // Explicitly unavailable on this platform (e.g. human_input on claude_api).
      // [def:tools-header]: drop these — do not emit.
      continue;
    }

    results.push({
      canonicalName: grant.toolName,
      platformAlias: binding.platformToolName,
      availability: binding.availability,
    });
  }

  return results;
}
