/**
 * vocabulary.ts — the ONE pinned list of the data verbs this package mounts
 * (SPEC.md §6.7), plus nothing else.
 *
 * ## Why this is its own leaf module
 *
 * `BACKLOG_VERBS` is read by two callers that must never drift apart:
 *
 *  - `server.ts` — the mount-time carve-out check and the four-transport
 *    surface projection; and
 *  - `query/views/catalog.ts` — the generated `verb` catalog, which must
 *    enumerate the SAME advertised surface a consumer reads.
 *
 * If `catalog.ts` imported `server.ts` for the list, the whole query layer
 * would transitively load the server's fastify/MCP plugin graph (a runtime
 * cycle `server → api → query → catalog → server`), which is both a startup
 * cost and a needless coupling. Declaring the constant in a module with zero
 * imports keeps `catalog.ts` on the leaf and lets `server.ts` re-export the
 * identical binding, so there is still exactly ONE list.
 *
 * The comment body below is reproduced verbatim from `server.ts` (its former
 * home) so the "why this list is pinned" rationale stays attached to the
 * value rather than the file it happens to live in.
 */

/**
 * SPEC.md §6.7 — the data verbs the whole surface consolidates onto:
 * the nine issue verbs plus `lookup`, §3a's registry CRUD verbs, and the
 * three §5 stats/rollup reads (`priority-matrix`/`part-of-rollup`/
 * `open-curve`), mounted as `backlog_<verb>`. Pinned here, next to the
 * carve-out it is the complement of, because it is the ONE list four separate
 * surfaces are checked against: the three apigen mounts derive their names
 * from the operation descriptors via `describeMountedSurface`, and `cli.ts`'s
 * argv parser — which is deliberately NOT an apigen mount, because apigen's
 * `parseArgs` cannot express the §2.1b positional form, projects `string[]`
 * as a JSON-valued flag where §7.3 wants comma-separated, and only sets
 * `process.exitCode` on a thrown `ApiError` (so an `ok:false` envelope would
 * exit 0, contradicting `BACKLOG_EXIT_CODE`) — has to be checked against this
 * list rather than derived from the mount.
 *
 * That asymmetry is exactly how a split brain starts, and this repo already
 * has one open as BUG-BACKLOG-MCP-CLI-SPLIT-BRAIN-001. `server.verbs.spec.ts`
 * asserts BOTH sides against this constant so a verb added to one surface and
 * forgotten on the other fails a test instead of shipping.
 *
 * Order is the SPEC.md §4/§6 declaration order, not alphabetical; compare as
 * sets.
 */
export const BACKLOG_VERBS: readonly string[] = [
  'get',
  'query',
  'priority-matrix',
  'part-of-rollup',
  'open-curve',
  'report',
  'lookup',
  'create',
  'update',
  'add-citation',
  'remove-citation',
  'transition',
  'attest',
  'recheck',
  'obligate',
  'unobligate',
  'spec-append',
  'spec-check',
  'claim',
  'relate',
  'move',
  'upsert-project',
  'upsert-component',
  'upsert-location',
  'rm-location',
  'delete',
  'embedding-status',
  'merge-project',
  'rm-project',
];
