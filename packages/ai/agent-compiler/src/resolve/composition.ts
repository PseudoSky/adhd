import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  CompositionStore,
  type CompositionContext,
} from '@adhd/agent-registry';

// ──────────────────────────────────────────────
// resolveBody — assemble a flat prompt body in junction order.
//
// The compiler's body assembly layer: calls agent-registry's
// CompositionStore.resolveComposition to get the ordered, version-pinned,
// context-filtered component list, then concatenates each component's content
// in the returned (position) order.
//
// [def:junction-order] — sections emitted in ascending position order, exactly
// as resolveComposition returns them (it is the single place ordering +
// filtering happen — [inv:context-precedence-consumed]).
//
// The platform header (frontmatter / JSON) is NOT this function's concern.
// It returns:
//   body              — flat string: component content sections in position order.
//   componentVersions — map of componentSlug → resolvedVersion for the cache key
//                       ([def:context-hash]).
// ──────────────────────────────────────────────

/** Map of component slug to its resolved version number, used to key the cache. */
export type ComponentVersionMap = Record<string, number>;

/** Return value of resolveBody. */
export interface ResolvedBody {
  /** Component content sections concatenated in ascending junction position order. */
  body: string;
  /** Map of componentSlug → resolvedVersion for cache-key computation. */
  componentVersions: ComponentVersionMap;
}

/**
 * Assemble the flat prompt body for an agent + runtime context.
 *
 * Delegates ordering, version-pin resolution, and context-condition filtering
 * entirely to {@link CompositionStore.resolveComposition} — this function does
 * NOT re-implement `ORDER BY position` or the context predicate evaluator.
 *
 * @param db         - The shared registry Drizzle handle (all four prefixes).
 * @param agentSlug  - Slug of the agent to compile.
 * @param context    - Runtime context key/value map for context-conditioned components.
 * @returns Flat ordered body string and per-component version map.
 *
 * @throws {CompositionError} AGENT_NOT_FOUND | COMPONENT_VERSION_NOT_FOUND |
 *   REQUIRED_COMPONENT_EXCLUDED — propagated unchanged from CompositionStore.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveBody(
  db: BetterSQLite3Database<any>,
  agentSlug: string,
  context: CompositionContext = {}
): ResolvedBody {
  // Single delegated call — ordering + version-pin + context filtering happen
  // here and nowhere else ([inv:context-precedence-consumed]).
  const store = new CompositionStore(db);
  const resolved = store.resolveComposition(agentSlug, context);

  const componentVersions: ComponentVersionMap = {};
  const sections: string[] = [];

  for (const rc of resolved) {
    sections.push(rc.component.content);
    componentVersions[rc.componentSlug] = rc.resolvedVersion;
  }

  const body = sections.join('\n');

  return { body, componentVersions };
}
