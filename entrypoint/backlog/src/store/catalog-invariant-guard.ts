/**
 * catalog-invariant-guard.ts — DETECT LOUDLY when the status/priority/kind catalog
 * violates an invariant this build's read layer depends on, and REPORT it.
 *
 * ## The posture: prevented at the write, detected loudly, never a gate
 *
 * A violation is PREVENTED where it is created and DETECTED where an operator
 * asks — and it is never allowed to take down reads OR unrelated writes.
 * Concretely:
 *
 *  - PREVENTION — `mintOrResolveCatalogTx` (`write/catalog.ts`) refuses a
 *    case-variant catalog name outright (`CaseVariantNameError`, naming both
 *    spellings), so a bad write cannot CREATE the drift in the first place.
 *    That is per-write, specific and targeted: it stops the one call that
 *    would mint the bad row, never an unrelated one.
 *  - DETECTION — the `store-check` CLI verb runs {@link assertCatalogInvariants}
 *    and exits NON-ZERO with this module's self-explaining message on a
 *    violation: a NAMED check an operator runs deliberately.
 *  - NOT A GATE — neither the ordinary READ path (`queryIssuesWithMeta`) nor
 *    the WRITE path (`api.ts`'s `writeHandle`) runs it. A drifted catalog is a
 *    bounded data problem; refusing every read over it is an unbounded
 *    availability failure (it caused two total outages), and refusing every
 *    write over it is the identical defect on the other side of the store.
 *    BOTH a read and an ordinary write of a drifted store SUCCEED.
 *
 * This is a named check, NOT a silent degrade and NOT a fallback: no name-keyed
 * shim is installed and no violation is swallowed — it is reported verbatim by
 * the check. It is deliberately NOT an unconditional read- or write-abort.
 *
 * ## The two invariants
 *
 * 1. TERMINALITY. `query/card.ts`'s `isStatusTerminal` reads
 *    `status.metadata.terminal === true`, defaulting FALSE when the key is
 *    absent. A live `status` row whose name is a reserved terminal name
 *    (`RESERVED_TERMINAL_STATUS_NAMES`, `write/catalog.ts`) but whose flag is
 *    not `true` therefore reads as NON-terminal: closed items come back under
 *    an `open` filter. The flag is the read-time source of truth, and the read
 *    layer is deliberately name-blind (ADR-0002 D1), so the flag must be
 *    correct on disk — the guard is not a read-time name fallback.
 *
 * 2. UNIQUENESS. No two live rows of the same catalog kind (`status`,
 *    `priority` or `kind`) may share a case-folded name. The read layer groups by NAME,
 *    never by fold, so a `HIGH`/`high` pair splits one priority across two
 *    rows and a name-keyed consumer double-counts. A fold collision within a
 *    kind is the signature of that case-fragment defect.
 *
 * ## Per kind, never across kinds
 *
 * The uniqueness check groups WITHIN each kind. A `status` named `open` and a
 * `priority` named `open` are two different catalogs reached by two different
 * edges (`has_status` vs `has_priority`) — they are not a duplicate, and an
 * ordinary `createIssue` can legitimately mint the second while the first
 * exists. Grouping across kinds would fire on that ordinary write, which this
 * guard must never do (ADR-0002 D5 step 4: a loud failure must name a real
 * open item, never manufacture one).
 *
 * ## Name the row, name the repair (ADR-0002 D1 + D5 step 4)
 *
 * {@link CatalogInvariantError} names every offending row (uid + name; for a
 * duplicate, the fold and both spellings) and states the repair that resolves
 * it, so an operator who runs the check can act without opening source. It
 * never silently degrades and never installs a read-time shim: a name fallback
 * would be a second, drifting source of truth (D1).
 *
 * ## Bounded by the catalog, never by the store
 *
 * The catalog is a handful of rows. Both checks are answered by ONE read of
 * every live `status`/`priority` row (`kind IN (...)`, `t_invalid IS NULL`),
 * folding names in JS. This never scans the issue graph and never runs a
 * `GROUP BY` over it, so it stays cheap for the operator-run check and for any
 * caller that asserts deliberately.
 * Folding is done in JS via {@link catalogNameFold} — never SQL `lower()`/
 * `NOCASE`, which folds only ASCII `A`–`Z` and would desync from the JS fold
 * the repair uses.
 *
 * ## The row vocabulary this build requires
 *
 * The two canonical-row properties above are the ONLY catalog invariants. The
 * guard does not police spelling (a canonical spelling is enforced by the
 * separate case-fragment repair, not here) — it polices the two properties the
 * read layer silently depends on.
 */
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { RESERVED_TERMINAL_STATUS_NAMES } from '../write/catalog.js';
import { catalogNameFold } from '../write/catalog-repair.js';

/** The catalog kinds this guard reads — a status/priority/kind rows-only read, never the issue graph. */
const GUARDED_CATALOG_KINDS = ['status', 'priority', 'kind'] as const;

/**
 * One way the catalog can violate an invariant. Carried as structured data on
 * {@link CatalogInvariantError} so a caller (a diagnostic, a test) can act on
 * the offending rows without parsing the rendered message.
 */
export type CatalogInvariantViolation =
  | {
      kind: 'unflagged-terminal';
      /** The row's own name, verbatim. */
      name: string;
      /** The row's uid — the handle a reader uses to inspect or repair it. */
      uid: string;
    }
  | {
      kind: 'case-fragment-duplicate';
      /** The case-folded name the rows collide on. */
      fold: string;
      /** Every colliding spelling, in rowid order (≥ 2). */
      names: readonly string[];
      /** The colliding rows' uids, aligned index-for-index with {@link names}. */
      uids: readonly string[];
    };

/**
 * The repair each violation names. Stated in the thrown message so a reader can
 * act without opening source: which module and functions resolve the row.
 */
const TERMINAL_REPAIR =
  "run the terminal-flag repair — `write/catalog-repair.ts`'s `planTerminalBackfill` + `applyTerminalBackfill` — which sets `metadata.terminal = true` on each named status row.";
const CASE_FRAGMENT_REPAIR =
  "run the case-fragment repair — `write/catalog-merge.ts`'s `planCaseFragmentMerge` + `applyCaseFragmentMerge` — which collapses each folded group to one live row, re-points its edges, and records the merged-away spelling as an alias.";

/**
 * Render a violation list into the self-explaining message the guard throws.
 * Exported so a diagnostic can reuse the exact wording the error carries.
 */
export function renderCatalogInvariantViolations(
  violations: ReadonlyArray<CatalogInvariantViolation>
): string {
  const unflagged = violations.filter(
    (v): v is Extract<CatalogInvariantViolation, { kind: 'unflagged-terminal' }> =>
      v.kind === 'unflagged-terminal'
  );
  const duplicates = violations.filter(
    (
      v
    ): v is Extract<
      CatalogInvariantViolation,
      { kind: 'case-fragment-duplicate' }
    > => v.kind === 'case-fragment-duplicate'
  );

  const lines: string[] = [
    'backlog: status/priority/kind catalog invariant violated (ADR-0002: correct the source, never work around it).',
  ];
  lines.push(
    '  This is a NAMED check: it reports the rows below and the repair. It never gates reads or unrelated writes — a drifted catalog is a bounded data problem, never an availability outage — and neither condition may be papered over with a read-time fallback.'
  );

  if (unflagged.length > 0) {
    lines.push(
      `  unflagged-terminal (${unflagged.length}): a live status row whose name is a reserved terminal name but whose metadata.terminal is not true reads as NON-terminal, so closed items are returned under an open filter.`
    );
    for (const v of unflagged) {
      lines.push(`    - status "${v.name}" (uid ${v.uid})`);
    }
    lines.push(`    remediation: ${TERMINAL_REPAIR}`);
  }

  if (duplicates.length > 0) {
    lines.push(
      `  case-fragment-duplicate (${duplicates.length}): two or more live rows of the SAME catalog kind share a case-folded name, so a name-keyed reader splits one value across two rows.`
    );
    for (const v of duplicates) {
      const pairs = v.names
        .map((name, i) => `"${name}" (uid ${v.uids[i]})`)
        .join(', ');
      lines.push(`    - fold "${v.fold}": ${pairs}`);
    }
    lines.push(`    remediation: ${CASE_FRAGMENT_REPAIR}`);
  }

  return lines.join('\n');
}

/**
 * The status/priority/kind catalog violates an invariant this build's read layer
 * depends on. Carries the offending rows as structured fields so a caller can
 * render them; the message itself names every row AND the repair.
 */
export class CatalogInvariantError extends Error {
  constructor(readonly violations: ReadonlyArray<CatalogInvariantViolation>) {
    super(renderCatalogInvariantViolations(violations));
    this.name = 'CatalogInvariantError';
  }
}

/**
 * {@link RESERVED_TERMINAL_STATUS_NAMES}, folded once at module load through
 * the SAME {@link catalogNameFold} the repair planner uses — the membership
 * key the terminality check tests a folded row name against. Derived, never a
 * second definition: the canonical set lives in `write/catalog.ts` and is only
 * re-projected here.
 */
const FOLDED_RESERVED_TERMINAL_STATUS_NAMES: ReadonlySet<string> = new Set(
  [...RESERVED_TERMINAL_STATUS_NAMES].map((name) => catalogNameFold(name))
);

/** One raw catalog row as read from the store, before any interpretation. */
interface IRawCatalogRow {
  rowid: number;
  uid: string;
  kind: string;
  name: string | null;
  meta: string | null;
}

/**
 * Guarded `JSON.parse` for a `node.meta` column value — the SAME
 * degrade-on-corruption discipline as `write/catalog.ts`'s (unexported)
 * `parseMetaObject`: a non-JSON or non-object `meta` degrades to `undefined`
 * rather than throwing a raw `SyntaxError`. A row with absent/corrupt `meta`
 * has no `terminal` flag, which the terminality check correctly reads as "not
 * true" (and, for a reserved name, as a violation).
 */
function parseMetaObject(
  raw: string | null
): Record<string, unknown> | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every live status/priority/kind row and return the invariant violations.
 * A pure read — it never writes, so it is safe against any store, including
 * the live one.
 *
 * BOUNDED by the catalog: exactly one statement against
 * `node WHERE kind IN ('status','priority') AND t_invalid IS NULL`, folding
 * each name in JS. The row set is the catalog (a handful of rows), never the
 * issue graph.
 */
export async function inspectCatalogInvariants(
  adapter: StoreAdapter
): Promise<CatalogInvariantViolation[]> {
  const { rows } = await adapter.executeAll<IRawCatalogRow>(
    'SELECT rowid, uid, kind, name, meta FROM node WHERE kind IN (?, ?, ?) AND t_invalid IS NULL ORDER BY kind ASC, rowid ASC',
    [...GUARDED_CATALOG_KINDS]
  );

  const violations: CatalogInvariantViolation[] = [];

  // Check 1 — terminality. Every live status whose FOLDED name is a reserved
  // terminal name must carry `metadata.terminal === true`. Mirrors the repair
  // planner's own folded classifier (a `Closed` row is caught just as `closed`
  // is), so the guard and the repair agree on exactly which rows are terminal.
  for (const row of rows) {
    if (row.kind !== 'status') continue;
    const folded = catalogNameFold(row.name ?? '');
    if (!FOLDED_RESERVED_TERMINAL_STATUS_NAMES.has(folded)) continue;
    if (parseMetaObject(row.meta)?.terminal === true) continue;
    violations.push({
      kind: 'unflagged-terminal',
      name: row.name ?? '',
      uid: row.uid,
    });
  }

  // Check 2 — uniqueness, grouped WITHIN each kind (see the module header:
  // a cross-kind name match is not a duplicate). Group order follows the
  // `rowid ASC` read, so both the group iteration and each group's spellings
  // are deterministic.
  for (const catalogKind of GUARDED_CATALOG_KINDS) {
    const byFold = new Map<string, IRawCatalogRow[]>();
    for (const row of rows) {
      if (row.kind !== catalogKind) continue;
      const fold = catalogNameFold(row.name ?? '');
      const group = byFold.get(fold);
      if (group) group.push(row);
      else byFold.set(fold, [row]);
    }
    for (const [fold, group] of byFold) {
      if (group.length < 2) continue;
      violations.push({
        kind: 'case-fragment-duplicate',
        fold,
        names: group.map((r) => r.name ?? ''),
        uids: group.map((r) => r.uid),
      });
    }
  }

  return violations;
}

/**
 * Assert the store's status/priority/kind catalog satisfies both invariants.
 *
 * Passes (no throw) on an empty store, and on a catalog whose reserved
 * terminal statuses are flagged and whose same-kind names are fold-unique.
 * Throws {@link CatalogInvariantError}, naming every offending row and the
 * repair that resolves it, otherwise.
 *
 * WHERE IT RUNS: the `store-check` CLI verb — a NAMED, non-zero check an
 * operator runs deliberately — plus any caller that asserts deliberately via
 * `IQueryStoreHandle.assertCatalogInvariants`. It is deliberately NOT run on
 * the ordinary read path (`queryIssuesWithMeta`), on the write path (`api.ts`'s
 * `writeHandle`), or at store open (`openGraphBacklogStore`): a violation must
 * be detected loudly and REPORTED, never allowed to turn every read — or every
 * unrelated write — into an outage.
 *
 * BOUNDED BY CONSTRUCTION: it must not scan the issue graph per call. It reads
 * only the (small) status/priority/kind catalog — see
 * {@link inspectCatalogInvariants}.
 */
export async function assertCatalogInvariants(
  adapter: StoreAdapter
): Promise<void> {
  const violations = await inspectCatalogInvariants(adapter);
  if (violations.length === 0) return;
  throw new CatalogInvariantError(violations);
}
