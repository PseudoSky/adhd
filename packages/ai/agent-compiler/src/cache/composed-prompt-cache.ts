// ──────────────────────────────────────────────
// composed-prompt-cache — cache lookup + write for the composed_prompts table.
//
// Implements Decision D (decisions.md [def:context-hash]):
//   context_hash = SHA-256( sortedJSON(context) + " " + sortedJSON(componentVersions) + " " + platform )
//
// The three-part key encodes:
//   1. The runtime context (any key/value change → different hash → cache miss).
//   2. The resolved component-version set (an unpinned component advancing to a
//      new latest → different componentVersions → miss).
//   3. The target platform (different platform → different content shape → miss).
//
// The "context part" reuses @adhd/agent-registry's exported `contextHash` helper
// for consistent sorted-key JSON canonicalization — do NOT reimplement
// ([ref:store-read], decisions.md Decision D note).
//
// The composed_prompts table comes from @adhd/agent-registry (plan 1,
// `registry_composed_prompts`).  We use the existing table via the shared DB
// handle passed by `compileAgent` ([inv:one-db-handle]).  No duplicate table
// is created here.
//
// [def:context-hash]    — the combined cache key algorithm (decisions.md Decision D)
// [inv:one-db-handle]   — shared Drizzle handle, all four table prefixes
// [inv:reopen-proves-cache] — persistence proven by CLOSE+REOPEN (test invariant)
// ──────────────────────────────────────────────

import { createHash } from 'node:crypto';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { ComposedPromptStore, contextHash as registryContextHash } from '@adhd/agent-registry';
import type { ComposedPrompt } from '@adhd/agent-registry';
import type { ComponentVersionMap } from '../resolve/composition.js';

// ──────────────────────────────────────────────
// Combined cache-key hash
// ──────────────────────────────────────────────

/**
 * Compute the combined `context_hash` for the `registry_composed_prompts` cache.
 *
 * Decision D (decisions.md): `context_hash = SHA-256(sortedJSON(context) + " " +
 * sortedJSON(componentVersions) + " " + platform)`.
 *
 * The `registryContextHash` (from @adhd/agent-registry) handles sorted-key JSON
 * canonicalization of the context part.  We apply the same sorted-key approach to
 * `componentVersions` and append the `platform` string as a third field so that any
 * of the three inputs changing produces a distinct hash.
 *
 * A ` ` (space) field separator is used between parts — plain JSON can never contain
 * an unescaped space at the top level, so the three blobs cannot collide by
 * concatenation.
 *
 * @param context           - Runtime context key/value map (e.g. `{ticket_type:"security"}`).
 * @param componentVersions - Resolved component-version map from `resolveComposition`.
 * @param platform          - Target platform id (e.g. `claude_code`, `claude_api`).
 * @returns 64-character lowercase hex SHA-256 string.
 */
export function computeContextHash(
  context:           Record<string, string>,
  componentVersions: ComponentVersionMap,
  platform:          string,
): string {
  // Part 1: sorted-key JSON of context (reuse the upstream helper for parity).
  const contextPart = registryContextHash(context);

  // Part 2: sorted-key JSON of componentVersions (apply the same canonicalization).
  const sortedVersions = Object.fromEntries(
    Object.keys(componentVersions).sort().map(k => [k, componentVersions[k]] as const)
  );
  const versionPart = JSON.stringify(sortedVersions);

  // Combined: context_hash(context) + " " + sortedJSON(componentVersions) + " " + platform
  // Field separator is a bare space — JSON strings never contain unescaped spaces
  // at the outermost level, so the three segments cannot collide.
  const combined = `${contextPart} ${versionPart} ${platform}`;
  return createHash('sha256').update(combined, 'utf8').digest('hex');
}

// ──────────────────────────────────────────────
// Cache operations
// ──────────────────────────────────────────────

/**
 * Look up a `registry_composed_prompts` row by `(agentSlug, platform, context_hash)`.
 *
 * The `context_hash` encodes `(context, componentVersions, platform)` per Decision D.
 * Returns the cached row (with its `id`) on a HIT, or `null` on a MISS.
 *
 * A cache hit means `compileAgent` can return the persisted `{id, content}` WITHOUT
 * re-running the resolve layers (the assembly step is bypassed).  This is the
 * `[dod.4]` negative-control guarantee: removing this SELECT before assembly causes
 * a duplicate row on every compile.
 *
 * @param db                - Shared Drizzle handle (all four table prefixes).
 * @param agentSlug         - Agent to look up.
 * @param platform          - Target platform id.
 * @param context           - Runtime context key/value map.
 * @param componentVersions - Resolved component-version map from `resolveComposition`.
 * @returns The cached `ComposedPrompt` row on a HIT, or `null` on a MISS.
 */
export function lookup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:                 BetterSQLite3Database<any>,
  agentSlug:          string,
  platform:           string,
  context:            Record<string, string>,
  componentVersions:  ComponentVersionMap,
): ComposedPrompt | null {
  const hash  = computeContextHash(context, componentVersions, platform);
  const store = new ComposedPromptStore(db);
  return store.lookup(agentSlug, hash);
}

/**
 * Write a new `registry_composed_prompts` row for `(agentSlug, platform, context_hash)`.
 *
 * Called on a cache MISS: after assembly is complete, persists the composed prompt
 * so subsequent compiles can hit the cache.  Returns the inserted row, including the
 * generated `id` (the [def:composed-output].id audit/cache handle).
 *
 * @param db                - Shared Drizzle handle (all four table prefixes).
 * @param agentSlug         - Agent the row belongs to.
 * @param platform          - Target platform id (folded into the hash).
 * @param context           - Runtime context key/value map used for assembly.
 * @param componentVersions - Resolved component-version map (audit trail).
 * @param content           - The assembled platform artifact (markdown, JSON, etc.).
 * @returns The inserted `ComposedPrompt` row with its generated `id`.
 */
export function write(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:                 BetterSQLite3Database<any>,
  agentSlug:          string,
  platform:           string,
  context:            Record<string, string>,
  componentVersions:  ComponentVersionMap,
  content:            string,
): ComposedPrompt {
  const hash  = computeContextHash(context, componentVersions, platform);
  const store = new ComposedPromptStore(db);
  return store.write({ agentSlug, contextHash: hash, content, componentVersions });
}
