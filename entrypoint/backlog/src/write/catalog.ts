/**
 * catalog.ts — hand-composed find-then-create for catalogs, `project`,
 * `component`, `location` (SPEC.md §1, §2, §3a, §4c, §6.1).
 *
 * Every business-key resolution here runs a `tx.executeGet` SELECT by
 * `(kind, name)` against the SAME `immediate`-mode transaction the calling
 * verb already opened, and only on a miss issues an INSERT against that same
 * `tx` handle (§4c) — never `GraphBackend.findOrCreateNode()`, which is two
 * separate, non-transactional autocommit statements with no race-safety
 * across concurrent processes (§1, §4c "findOrCreateNode is not race-free").
 *
 * §6.1's mint-vs-throw rule, mechanically:
 * - `kind`/`status`/`priority`/`agent` — flat catalogs, mintable on an
 *   unresolved NAME (never on an unresolved uid-shaped ref).
 * - `project`/`component` — resolved-ONLY by every issue verb. A `project`
 *   NAME that doesn't resolve throws; `component` likewise (its own
 *   vivification path is the explicit `upsertComponent` registry verb, out
 *   of scope for this slice).
 * - `edge_kind` — never caller-mintable at all; every row is seeded once
 *   from §3's fixed edge table. See {@link resolveEdgeKindTx}'s doc comment
 *   for how this slice reconciles that with the absence of a dedicated seed
 *   script in this task's scope.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  CaseVariantNameError,
  CatalogNotFoundError,
  InvalidArgumentError,
  assertNotBareRoleLiteral,
} from './errors.js';
import { catalogNameFold } from './catalog-repair.js';
import { isUidShaped } from './uid-prefix.js';
import {
  type IEdgeKindRule,
  type IWriteStoreHandle,
  type ITxNodeRow,
  executeWriteTransaction,
  getNodeByUidTx,
  invalidateEdgeTx,
  nowISO,
  resolveUidPrefixTx,
  writeEdgeTx,
  writeNodeTx,
} from './tx.js';
import { writeAudit } from './audit.js';
import { defaultCitationAllowedExternalRoots } from './citation-path.js';
import type {
  IComponentSummary,
  ILocationSummary,
  ILocationType,
  IProjectSummary,
} from '../query/types.js';

/**
 * Guarded `JSON.parse` for a `node.meta` column value — the SAME
 * degrade-on-corruption semantics as `tx.ts`'s own (unexported)
 * `parseJsonObject`: a non-JSON or non-object `meta` value degrades to
 * `undefined` rather than throwing a raw `SyntaxError`. `tx.ts`'s helper
 * isn't exported, so this is a local, behavior-identical equivalent — never
 * a divergent parsing rule of its own. Used everywhere in this module a
 * `meta` column is read back and interpreted (Finding 1: an unguarded parse
 * here would surface as `E_IO`/`retryable: true` at the `executeWriteTransaction`
 * boundary, retrying a deterministic corrupt-row failure forever).
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
 * Disambiguation by SHAPE, not a second field (§6.1): a 36-character
 * version-4-UUID-formatted string is a `uid`; anything else is a `name`. The
 * single definition lives in `write/uid-prefix.ts` (which also owns prefix
 * classification); re-exported here so every existing `isUidShaped` importer
 * keeps its path unchanged.
 */
export { isUidShaped };

export interface IResolvedCatalogRow {
  rowid: number;
  uid: string;
  name: string;
}

export interface IResolvedProjectRow extends IResolvedCatalogRow {
  metadata: Record<string, unknown> | undefined;
}

/** {@link resolveByUidTx}'s return type, narrowed so `name` is never `null` — see its doc comment. */
interface IResolvedTxNodeRow extends Omit<ITxNodeRow, 'name'> {
  name: string;
}

/**
 * Resolve `ref` against `expectedKind` by `uid`, inside `tx`. Throws
 * {@link CatalogNotFoundError} when no LIVE node with that uid exists, or it
 * exists but is a different `kind` — a uid is never ambiguous, so any
 * mismatch is a hard error, never a silent fallback.
 *
 * A resolved row with a NULL `name` column is likewise treated as an
 * unresolved reference (Finding 3), never silently degraded to the `uid`
 * itself: every call site here used to fall back to `row.name ?? ref`, which
 * leaked the internal `uid` into the business-facing `.name` field — from
 * there it flowed into `create-issue.ts`'s `allowedKinds`/`allowedStatuses`
 * string comparisons (silently failing a check it should never have reached)
 * and into the caller-visible response. §3's catalog kinds (`project`,
 * `component`, `kind`, `status`, `priority`, `agent`) all carry a name by
 * design, so a live row of one of those kinds with no name is corrupt data —
 * signalled via the SAME `CatalogNotFoundError` §4c's taxonomy already uses
 * for "did not resolve," not a new error class.
 */
async function resolveByUidTx(
  tx: AdapterTransaction,
  expectedKind: string,
  uid: string
): Promise<IResolvedTxNodeRow> {
  // Accepts an exact uid or a UNIQUE uid prefix (`rmLocation` unions the
  // latter; `resolveUidPrefixTx` throws `AmbiguousReferenceError` on a
  // multi-match and the kind-appropriate not-found on a miss).
  const row = await resolveUidPrefixTx(tx, uid, { expectedKind });
  const { name } = row;
  if (name === null) {
    throw new CatalogNotFoundError(expectedKind, uid);
  }
  return { ...row, name };
}

/**
 * `project` (§1, §6.1): resolved-ONLY, `uid` or `name`, NEVER minted by an
 * issue verb — minting a project is the explicit `upsertProject` registry
 * verb's job alone (§3a), out of scope for this slice.
 */
export async function resolveProjectTx(
  tx: AdapterTransaction,
  ref: string
): Promise<IResolvedProjectRow> {
  if (isUidShaped(ref)) {
    const row = await resolveByUidTx(tx, 'project', ref);
    return {
      rowid: row.rowid,
      uid: row.uid,
      name: row.name,
      metadata: row.metadata,
    };
  }
  const row = await tx.executeGet<{
    rowid: number;
    uid: string;
    name: string | null;
    meta: string | null;
  }>(
    "SELECT rowid, uid, name, meta FROM node WHERE kind = 'project' AND name = ? AND t_invalid IS NULL LIMIT 1",
    [ref]
  );
  if (!row) throw new CatalogNotFoundError('project', ref);
  let metadata: Record<string, unknown> | undefined;
  if (row.meta !== null) {
    try {
      metadata = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
  }
  return { rowid: row.rowid, uid: row.uid, name: row.name ?? ref, metadata };
}

/**
 * `component`, scoped within `project` (§6.1, §6.3.2): resolved-ONLY, `uid`
 * or `name` — an unresolved name throws `CatalogNotFoundError('component', name)`
 * rather than silently forking a new component under the given project.
 */
export async function resolveComponentTx(
  tx: AdapterTransaction,
  input: { projectUid: string; ref: string }
): Promise<IResolvedCatalogRow> {
  if (isUidShaped(input.ref)) {
    const row = await resolveByUidTx(tx, 'component', input.ref);
    const rowProjectUid = row.metadata?.projectUid;
    if (rowProjectUid !== input.projectUid) {
      throw new CatalogNotFoundError('component', input.ref);
    }
    return { rowid: row.rowid, uid: row.uid, name: row.name };
  }
  const row = await tx.executeGet<{
    rowid: number;
    uid: string;
    name: string | null;
  }>(
    `SELECT rowid, uid, name FROM node
     WHERE kind = 'component' AND name = ? AND t_invalid IS NULL
       AND json_extract(meta, '$.projectUid') = ?
     LIMIT 1`,
    [input.ref, input.projectUid]
  );
  if (!row) throw new CatalogNotFoundError('component', input.ref);
  return { rowid: row.rowid, uid: row.uid, name: row.name ?? input.ref };
}

/**
 * `project`'s reserved default component, `(root)` (§3, §6.1, §6.3.2,
 * §8 AC-23): what `createIssue` resolves to when `component` is omitted.
 * A row `upsertProject` already guarantees is live for every project — NEVER
 * minted here, in either case (§1). Resolved via `owns_project` (the SAME
 * traversal §3a's registry uses), not a bare name lookup, so a `(root)` row
 * belonging to a DIFFERENT project can never be mismatched onto this one.
 */
export async function resolveDefaultComponentTx(
  tx: AdapterTransaction,
  input: { projectRowid: number }
): Promise<IResolvedCatalogRow> {
  const row = await tx.executeGet<{
    rowid: number;
    uid: string;
    name: string | null;
  }>(
    `SELECT c.rowid AS rowid, c.uid AS uid, c.name AS name
     FROM edge e JOIN node c ON c.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'owns_project' AND e.t_invalid IS NULL
       AND c.name = '(root)' AND c.t_invalid IS NULL
     LIMIT 1`,
    [input.projectRowid]
  );
  if (!row) throw new CatalogNotFoundError('component', '(root)');
  return { rowid: row.rowid, uid: row.uid, name: row.name ?? '(root)' };
}

export type FlatCatalogKind = 'kind' | 'status' | 'priority' | 'agent';

export interface IMintOrResolveInput {
  catalogKind: FlatCatalogKind;
  ref: string;
  /** Metadata to seed onto a MINTED row only — never read or applied when `ref` resolves to an existing row. Evaluated lazily (only on an actual mint) since e.g. `priority`'s rank needs a fresh in-tx MAX query (§6.3.2). */
  mintMetadata?: (tx: AdapterTransaction) => Promise<Record<string, unknown>>;
  /**
   * The caller's single logical-write timestamp, forwarded to `writeNodeTx` so a
   * minted catalog row carries the SAME `t_created`/`t_valid` as the issue that
   * caused the mint. Omitted, `writeNodeTx` stamps its own `nowISO()`, which is
   * what produced per-row drift within one `createIssue`.
   *
   * Deliberately NOT threaded into `resolveEdgeKindTx`'s `edge_kind` rows: those
   * are schema-infrastructure rows describing the relation table itself, not part
   * of any one issue's logical write, so they keep their own clock.
   */
  at?: string;
}

/**
 * The reserved TERMINAL status vocabulary — the ONE in-code definition
 * (SPEC.md §2: `status.terminal` drives closedness). Modelled directly on
 * {@link EDGE_KIND_TABLE} further down this file: a frozen in-code table the
 * mint layer seeds from, exactly as {@link resolveEdgeKindTx} seeds
 * `edge_kind` from §3's fixed edge table.
 *
 * The flag, never the name, is the read-time source of truth —
 * `query/card.ts`'s `isStatusTerminal` stays name-blind (ADR-0002 D1: an
 * unfixed-source gap is repaired at the SOURCE, never papered over with a
 * read-time name fallback, which would be a second, drifting source of
 * truth). This table is that source fix: a name listed here that has no live
 * `status` row is SEEDED `terminal:true` by {@link mintOrResolveStatusTx}, so
 * minting `closed` (or any other reserved name) can no longer produce a row
 * that reads as non-terminal — the drift `catalog-repair.ts` exists to clean
 * up is not regenerated on the next mint.
 *
 * Membership is decided on the FOLDED name ({@link catalogNameFold}) — the
 * same Unicode fold the duplicate guard and the case-fragment repair use, never
 * SQL `lower()`/`NOCASE`, which fold only ASCII `A`–`Z`. The spellings below
 * are the canonical catalog rows, but the PREDICATE folds, so `Closed`,
 * `fixed`, `resolved` and `done` all count as reserved. This matters because a
 * first-ever lowercase `fixed`/`resolved`/`done` has no uppercase row to
 * collide against; under an exact-case predicate it would seed
 * `terminal:false` — a closed status the read layer returns as open (backlog
 * b4525bc3 / d7ec2c50). There is exactly ONE such table in the codebase
 * (`catalog-repair.ts` re-exports this set rather than declaring its own).
 */
export const RESERVED_TERMINAL_STATUS_NAMES: ReadonlySet<string> = new Set([
  'closed',
  'DONE',
  'FIXED',
  'RESOLVED',
  'INVALID',
  'SUPERSEDED',
]);

/** {@link RESERVED_TERMINAL_STATUS_NAMES}, folded once at module load — the membership key {@link isReservedTerminalStatusName} tests a folded name against. */
const FOLDED_RESERVED_TERMINAL_STATUS_NAMES: ReadonlySet<string> = new Set(
  [...RESERVED_TERMINAL_STATUS_NAMES].map((name) => catalogNameFold(name))
);

/** Whether `name` is one of {@link RESERVED_TERMINAL_STATUS_NAMES} under the case fold — so any spelling of the reserved terminal vocabulary (`closed`/`Closed`/`CLOSED`, `fixed`/`FIXED`) counts. */
export function isReservedTerminalStatusName(name: string): boolean {
  return FOLDED_RESERVED_TERMINAL_STATUS_NAMES.has(catalogNameFold(name));
}

/**
 * Find a LIVE row of `catalogKind` whose name folds to the same token as `ref`
 * but is not spelled identically — the case-variant the write path refuses.
 *
 * Folding is done in JS via {@link catalogNameFold}, never SQL `lower()`/
 * `NOCASE` (ASCII-only, would desync from the fold the guard and the repair
 * use). The read is BOUNDED by the catalog: one statement over the live rows of
 * one kind (a handful of rows), not the issue graph. It runs against the
 * caller's own `immediate`-mode `tx`, so it is race-safe with the mint that
 * follows: two concurrent processes cannot both hold the transaction, and the
 * one that commits first makes the other's exact SELECT a hit (or its fold
 * check a genuine collision) before either can insert.
 *
 * `ORDER BY rowid ASC` makes the reported `canonicalName` deterministic when a
 * store somehow holds several folded variants at once (the state the guard
 * refuses to serve); we still name the lowest-rowid live row.
 */
async function findCaseVariantCatalogRowTx(
  tx: AdapterTransaction,
  catalogKind: FlatCatalogKind,
  ref: string
): Promise<{ uid: string; name: string } | undefined> {
  const refFold = catalogNameFold(ref);
  const { rows } = await tx.executeAll<{ uid: string; name: string | null }>(
    'SELECT uid, name FROM node WHERE kind = ? AND t_invalid IS NULL ORDER BY rowid ASC',
    [catalogKind]
  );
  for (const row of rows) {
    if (row.name === null || row.name === ref) continue;
    if (catalogNameFold(row.name) === refFold) {
      return { uid: row.uid, name: row.name };
    }
  }
  return undefined;
}

/**
 * The flat-catalog find-then-create (§1, §4c, §6.1): `kind`/`status`/
 * `priority`/`agent` are mintable on an unresolved NAME; a uid-shaped `ref`
 * that does not resolve instead throws — minting NEVER applies to a uid.
 *
 * A NAME that case-folds to an EXISTING LIVE row of the same kind but is
 * spelled differently (`IN_PROGRESS` when `in_progress` is live) is REFUSED
 * with {@link CaseVariantNameError} — never fold-resolved onto the existing
 * row, never minted as a twin. Identity is exact-case (`WHERE name = ?`), so a
 * variant is neither the same row nor a genuinely new name; it is ambiguous,
 * and the ambiguity is stopped here rather than allowed to grow a duplicate
 * the catalog-invariant guard would then abort every read over.
 */
export async function mintOrResolveCatalogTx(
  tx: AdapterTransaction,
  input: IMintOrResolveInput
): Promise<IResolvedCatalogRow> {
  if (isUidShaped(input.ref)) {
    const row = await resolveByUidTx(tx, input.catalogKind, input.ref);
    return { rowid: row.rowid, uid: row.uid, name: row.name };
  }

  const existing = await tx.executeGet<{
    rowid: number;
    uid: string;
    name: string | null;
  }>(
    'SELECT rowid, uid, name FROM node WHERE kind = ? AND name = ? AND t_invalid IS NULL LIMIT 1',
    [input.catalogKind, input.ref]
  );
  if (existing) {
    return {
      rowid: existing.rowid,
      uid: existing.uid,
      name: existing.name ?? input.ref,
    };
  }

  // The exact-name SELECT missed. Before minting, refuse a case-variant of an
  // existing live row — still inside the SAME immediate transaction, so no
  // concurrent writer can slip a colliding row in between this check and the
  // INSERT below.
  const variant = await findCaseVariantCatalogRowTx(
    tx,
    input.catalogKind,
    input.ref
  );
  if (variant) {
    throw new CaseVariantNameError(input.catalogKind, variant.name, input.ref);
  }

  const metadata = input.mintMetadata ? await input.mintMetadata(tx) : {};
  const minted = await writeNodeTx(tx, {
    kind: input.catalogKind,
    name: input.ref,
    metadata,
    at: input.at,
  });
  return { rowid: minted.rowid, uid: minted.uid, name: input.ref };
}

/**
 * Resolve-or-seed a `status` catalog row (§2, §6.1, §6.3.2, §6.3.4) — the
 * ONE sanctioned status mint path, and the write-side counterpart of the
 * read-side `query/card.ts`'s `isStatusTerminal`.
 *
 * Unlike the generic {@link mintOrResolveCatalogTx}, it SEEDS `terminal` from
 * the frozen {@link RESERVED_TERMINAL_STATUS_NAMES} table on a miss — never
 * from a call-site literal (`terminal:false` hardcoded at the call site was
 * the drift's root cause) and never from a read-time name heuristic
 * (`isStatusTerminal` stays name-blind, ADR-0002 D1). A name in the table
 * seeds `terminal:true`; every other name seeds the pre-existing
 * `terminal:false` default (§6.3.2: a novel or mistyped name must never
 * silently close or exclude an item).
 *
 * Self-healing and idempotent, exactly like {@link resolveEdgeKindTx}: the
 * exact `(kind,name)` lookup inside {@link mintOrResolveCatalogTx} finds the
 * seeded row on every subsequent call, so reseeding never duplicates — the
 * store converges to one live `status` row per name. A case-variant name
 * (`Closed` vs a seeded `closed`) is REFUSED by {@link mintOrResolveCatalogTx}
 * with {@link CaseVariantNameError} rather than folded onto the existing row or
 * minted as a twin — the same exact-case stop every other flat catalog takes
 * (see that function's doc comment).
 *
 * A uid-shaped `ref` that does not resolve still throws
 * `CatalogNotFoundError` — minting never applies to a uid (§6.1).
 */
export async function mintOrResolveStatusTx(
  tx: AdapterTransaction,
  input: { ref: string; at?: string }
): Promise<IResolvedCatalogRow> {
  return mintOrResolveCatalogTx(tx, {
    catalogKind: 'status',
    ref: input.ref,
    at: input.at,
    mintMetadata: async () => ({
      terminal: isReservedTerminalStatusName(input.ref),
    }),
  });
}

/** `priority`'s mint rule (§6.3.2): "rank set to one past the current max rank (i.e. lowest urgency) — a novel priority can never silently outrank an existing one." */
export async function nextPriorityRankTx(
  tx: AdapterTransaction
): Promise<number> {
  const row = await tx.executeGet<{ maxRank: number | null }>(
    "SELECT MAX(CAST(json_extract(meta, '$.rank') AS INTEGER)) AS maxRank FROM node WHERE kind = 'priority' AND t_invalid IS NULL"
  );
  const maxRank = row?.maxRank ?? null;
  return maxRank === null ? 0 : maxRank + 1;
}

/**
 * §3's fixed edge table — the ONE declared shape for every `rel` (§2's
 * closing statement: "the SAME check for every row, never two different
 * checks"). `audits`' `source_kind: '*'` is the one declared sentinel (§2).
 */
export const EDGE_KIND_TABLE: readonly IEdgeKindRule[] = [
  {
    rel: 'owns_project',
    sourceKind: 'project',
    targetKind: 'component',
    multiplicity: '1:n',
  },
  {
    rel: 'owns_component',
    sourceKind: 'component',
    targetKind: 'issue',
    multiplicity: '1:n',
  },
  {
    rel: 'has_kind',
    sourceKind: 'issue',
    targetKind: 'kind',
    multiplicity: 'n:1',
  },
  {
    rel: 'has_status',
    sourceKind: 'issue',
    targetKind: 'status',
    multiplicity: 'n:1',
  },
  {
    rel: 'has_priority',
    sourceKind: 'issue',
    targetKind: 'priority',
    multiplicity: 'n:1',
  },
  {
    rel: 'authored_by',
    sourceKind: 'issue',
    targetKind: 'agent',
    multiplicity: 'n:1',
  },
  {
    rel: 'has_note',
    sourceKind: 'issue',
    targetKind: 'note',
    multiplicity: '1:n',
  },
  {
    rel: 'has_citation',
    sourceKind: 'issue',
    targetKind: 'citation',
    multiplicity: '1:n',
  },
  {
    rel: 'has_transition',
    sourceKind: 'issue',
    targetKind: 'transition',
    multiplicity: '1:n',
  },
  { rel: 'audits', sourceKind: '*', targetKind: 'audit', multiplicity: '1:n' },
  {
    rel: 'depends_on',
    sourceKind: 'component',
    targetKind: 'component',
    multiplicity: 'n:m',
  },
  {
    rel: 'has_location',
    sourceKind: 'component',
    targetKind: 'location',
    multiplicity: '1:n',
  },
  {
    rel: 'relates_to',
    sourceKind: 'issue',
    targetKind: 'issue',
    multiplicity: 'n:m',
  },
  {
    rel: 'supersedes',
    sourceKind: 'issue',
    targetKind: 'issue',
    multiplicity: 'n:1',
  },
  {
    rel: 'blocks',
    sourceKind: 'issue',
    targetKind: 'issue',
    multiplicity: 'n:m',
  },
  {
    rel: 'duplicate_of',
    sourceKind: 'issue',
    targetKind: 'issue',
    multiplicity: 'n:1',
  },
  {
    rel: 'part_of',
    sourceKind: 'issue',
    targetKind: 'issue',
    multiplicity: 'n:1',
  },
  {
    // C10 (foundation amendment, requested by C10's spec / C3's reciprocal
    // note): an attestation's subject may be an `issue` (C3) OR a `SPEC`
    // revision (C10's annotation — `subject.id` is the revision uid). The `'*'`
    // sentinel (`audits` already uses it) skips the source-kind match, so the
    // existing issue-subject path is byte-for-byte unchanged while a revision
    // annotation no longer trips `BacklogEdgeKindMismatchError`.
    rel: 'attests',
    sourceKind: '*',
    targetKind: 'attestation',
    multiplicity: '1:n',
  },
  {
    rel: 'has_obligation',
    sourceKind: 'issue',
    targetKind: 'obligation',
    multiplicity: '1:n',
  },
  {
    rel: 'satisfies',
    sourceKind: 'obligation',
    targetKind: 'attestation',
    multiplicity: 'n:m',
  },
] as const;

const EDGE_KIND_BY_REL: ReadonlyMap<string, IEdgeKindRule> = new Map(
  EDGE_KIND_TABLE.map((rule) => [rule.rel, rule])
);

/**
 * Resolve the `edge_kind` catalog row for `rel`, inside `tx` — the SAME
 * `tx.executeGet` lookup §1 describes for the VALIDATION half of every edge
 * write. `edge_kind` is NEVER caller-mintable (§1, §6.1): every row is
 * "seeded once from §3's fixed edge table," normally by a dedicated
 * bootstrap/seed step (§8.6 step 2 is the ETL's own version of this same
 * seeding).
 *
 * **Documented deviation for this slice.** This task ships the write-layer
 * core only (`errors.ts`/`tx.ts`/`catalog.ts`/`audit.ts`/`create-issue.ts`) —
 * no dedicated seed/bootstrap script exists yet to have run before
 * `createIssue` is first called. Rather than make `createIssue` depend on an
 * out-of-scope script, this function self-heals: on a miss, it seeds the
 * row from {@link EDGE_KIND_TABLE} — the IDENTICAL fixed §3 shape a real seed
 * script would write, never a caller-supplied one — inside the SAME `tx` the
 * calling verb already opened. This satisfies "seeded once" (idempotent:
 * the `tx.executeGet` above finds it on every subsequent call) without
 * requiring a separate bootstrap step to exist first. A future seed script
 * making this self-heal path dead code is expected and fine — the row shape
 * it would find already-present is identical either way.
 *
 * **A malformed row (should never happen — only this module ever writes
 * one) is guarded, never crashed on, and never left to accumulate.** `meta`
 * is read via {@link parseMetaObject} — a non-JSON `meta` value degrades to
 * `{}` instead of throwing a raw `SyntaxError` out of the transaction
 * callback (Finding 1: unguarded, that would misclassify as a retryable
 * `E_IO` at `executeWriteTransaction`'s boundary and retry forever against a
 * deterministic parse failure). Either that degraded `{}`, or a
 * successfully-parsed object missing one of the three expected keys, takes
 * the SAME "malformed" branch below: the row is invalidated and a correct
 * replacement is minted from {@link EDGE_KIND_TABLE} in the SAME `tx`, so the
 * next call's SELECT (now a deterministic `ORDER BY rowid` — the prior
 * ordering-free `LIMIT 1` made which duplicate got read unspecified, Finding
 * 2) can never re-find the malformed row and re-mint yet another duplicate.
 * The store converges to exactly one live `edge_kind` row per `rel` after
 * this call, rather than growing an unbounded set of malformed duplicates.
 */
export async function resolveEdgeKindTx(
  tx: AdapterTransaction,
  rel: string
): Promise<IEdgeKindRule> {
  const row = await tx.executeGet<{ rowid: number; meta: string | null }>(
    "SELECT rowid, meta FROM node WHERE kind = 'edge_kind' AND name = ? AND t_invalid IS NULL ORDER BY rowid ASC LIMIT 1",
    [rel]
  );
  if (row) {
    const meta = parseMetaObject(row.meta) ?? {};
    const sourceKind =
      typeof meta.source_kind === 'string' ? meta.source_kind : undefined;
    const targetKind =
      typeof meta.target_kind === 'string' ? meta.target_kind : undefined;
    const multiplicity = meta.multiplicity as
      | IEdgeKindRule['multiplicity']
      | undefined;
    if (sourceKind && targetKind && multiplicity) {
      return { rel, sourceKind, targetKind, multiplicity };
    }

    const fixed = EDGE_KIND_BY_REL.get(rel);
    if (!fixed) throw new CatalogNotFoundError('edge_kind', rel);

    // Self-heal AND converge (Finding 2): invalidate the malformed row in
    // the SAME tx as minting its replacement, using the SAME
    // `t_invalid IS NULL` live-row predicate this module uses everywhere
    // else, so the row can never be re-selected by a future call.
    await tx.executeRun(
      'UPDATE node SET t_invalid = ? WHERE rowid = ? AND t_invalid IS NULL',
      [nowISO(), row.rowid]
    );
    await writeNodeTx(tx, {
      kind: 'edge_kind',
      name: rel,
      metadata: {
        source_kind: fixed.sourceKind,
        target_kind: fixed.targetKind,
        multiplicity: fixed.multiplicity,
      },
    });
    return fixed;
  }

  const fixed = EDGE_KIND_BY_REL.get(rel);
  if (!fixed) throw new CatalogNotFoundError('edge_kind', rel);

  await writeNodeTx(tx, {
    kind: 'edge_kind',
    name: rel,
    metadata: {
      source_kind: fixed.sourceKind,
      target_kind: fixed.targetKind,
      multiplicity: fixed.multiplicity,
    },
  });
  return fixed;
}

/**
 * Per-project policy (§2): DATA, realized as `project.meta.metadata.policy`
 * — §2's table has no dedicated node/edge of its own (it is 1:1 with
 * `project`, never many-to-many), so it lives inside the SAME metadata blob
 * `project`'s other declared fields (`repoUrl`, `monorepo`, …, §3a) already
 * occupy. Every field defaults exactly as §2 states when the project carries
 * no `policy` object at all (a project seeded before policy existed, or
 * minimally).
 */
export interface IProjectPolicy {
  readonly transitionRequiresNote: boolean;
  readonly citationRequired: boolean;
  readonly citationRequiresSha: boolean;
  /**
   * External filesystem roots (absolute paths) this project may cite from, in
   * ADDITION to its own `metadata.path` root (BUG c6d35272). A citation target
   * is accepted iff its CANONICAL (symlink-resolved) path lies within the
   * project root OR one of these roots (`citation-path.ts`'s
   * `resolveCitationTarget`); a `..` traversal or a symlink that escapes stays
   * rejected, and an arbitrary absolute path outside every root is never
   * readable. Only the resulting `sha` is persisted — never file content.
   *
   * This layer defaults to the EMPTY array, and {@link resolveProjectPolicy}'s
   * injected runtime default (`defaultCitationAllowedExternalRoots()`) is ALSO
   * empty — there is NO machine-global default root (BUG 62059b57 follow-up:
   * the store's `~/.adhd/backlog` data home is not citable). A project opts
   * into the external carve-out by naming roots here; an empty array (the
   * default, or an explicit `[]`) leaves it disabled. This is TYPED,
   * per-project config — deliberately never an environment toggle.
   */
  readonly citationAllowedExternalRoots: readonly string[];
  readonly defaultStatus?: string;
  readonly defaultKind?: string;
  readonly dedupeScanEnabled: boolean;
  readonly dedupeThreshold: number;
  readonly claimStaleAfterMin: number;
  /** `project_status` — empty means "no restriction" (§2). */
  readonly allowedStatuses: readonly string[];
  /** `project_kind` — empty means "no restriction" (§2). */
  readonly allowedKinds: readonly string[];
  /** `project_field_requirement` — field names required on every mutating write for this project (§2). */
  readonly requiredFields: readonly string[];
}

/**
 * Frozen (Finding 4): every field of {@link IProjectPolicy} is now genuinely
 * `readonly` at the type level (the scalar fields carried no `readonly`
 * before, only the three array fields' element type did), AND the singleton
 * itself is `Object.freeze`d, AND {@link resolveProjectPolicy} always returns
 * a FRESH object on every call — never this reference. Three independent
 * layers so a future "local override" assignment onto a resolved policy is
 * structurally impossible (compile error), runtime-impossible (frozen, throws
 * in strict mode / silently no-ops otherwise), and even a bypass of the first
 * two (e.g. via `as any`) can no longer corrupt every project's default,
 * because callers never hold a reference to this object in the first place.
 */
const DEFAULT_PROJECT_POLICY: IProjectPolicy = Object.freeze({
  transitionRequiresNote: true,
  citationRequired: false,
  citationRequiresSha: true,
  // Frozen empty PLACEHOLDER, not the real default: `resolveProjectPolicy`
  // injects `defaultCitationAllowedExternalRoots()` on every resolve rather
  // than baking it into this module-load constant. The runtime default is also
  // empty (no machine-global root), so an explicitly-empty policy array and the
  // default coincide — both mean "no external roots".
  citationAllowedExternalRoots: Object.freeze([]),
  dedupeScanEnabled: true,
  dedupeThreshold: 0.8,
  claimStaleAfterMin: 30,
  allowedStatuses: [],
  allowedKinds: [],
  requiredFields: [],
});

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

export function resolveProjectPolicy(
  project: IResolvedProjectRow
): IProjectPolicy {
  const raw = project.metadata?.policy;
  if (raw === null || typeof raw !== 'object')
    return {
      ...DEFAULT_PROJECT_POLICY,
      citationAllowedExternalRoots: defaultCitationAllowedExternalRoots(),
    };
  const policy = raw as Partial<IProjectPolicy>;
  return {
    transitionRequiresNote:
      policy.transitionRequiresNote ??
      DEFAULT_PROJECT_POLICY.transitionRequiresNote,
    citationRequired:
      policy.citationRequired ?? DEFAULT_PROJECT_POLICY.citationRequired,
    citationRequiresSha:
      policy.citationRequiresSha ?? DEFAULT_PROJECT_POLICY.citationRequiresSha,
    // Validated then injected on both branches (this one and the no-`policy`
    // object branch above): a malformed value falls back to the runtime default
    // rather than being spread, and `defaultCitationAllowedExternalRoots()` is
    // read at CALL time, never frozen at module load.
    citationAllowedExternalRoots: resolveCitationAllowedExternalRoots(policy),
    defaultStatus: policy.defaultStatus,
    defaultKind: policy.defaultKind,
    dedupeScanEnabled:
      policy.dedupeScanEnabled ?? DEFAULT_PROJECT_POLICY.dedupeScanEnabled,
    dedupeThreshold:
      policy.dedupeThreshold ?? DEFAULT_PROJECT_POLICY.dedupeThreshold,
    claimStaleAfterMin:
      policy.claimStaleAfterMin ?? DEFAULT_PROJECT_POLICY.claimStaleAfterMin,
    allowedStatuses:
      policy.allowedStatuses ?? DEFAULT_PROJECT_POLICY.allowedStatuses,
    allowedKinds: policy.allowedKinds ?? DEFAULT_PROJECT_POLICY.allowedKinds,
    requiredFields:
      policy.requiredFields ?? DEFAULT_PROJECT_POLICY.requiredFields,
  };
}

/**
 * Validate `project_policy.citationAllowedExternalRoots` before it is used
 * (BUG 62059b57 follow-up). The policy blob is operator-supplied JSON (§2), so
 * this field can arrive as ANY type. It must be a `string[]`: spreading a bare
 * string would yield its characters (`'abc'` → `['a','b','c']`) and spreading a
 * non-array object would yield nothing, either silently corrupting the
 * carve-out. A malformed value falls back to the runtime default (the EMPTY
 * array — no external roots, the narrowest possible surface) — one bad policy
 * field must not brick every operation on an otherwise-valid project, which
 * throwing here would do, and the fallback can never WIDEN the read surface. An
 * explicitly valid `[]` is preserved (it disables the carve-out).
 */
function resolveCitationAllowedExternalRoots(
  policy: Partial<IProjectPolicy>
): readonly string[] {
  // `unknown`, not the declared `readonly string[] | undefined`: the static
  // type is a LIE at runtime — the value comes from parsed JSON — and this
  // guard is exactly what makes the runtime match the type.
  const raw: unknown = policy.citationAllowedExternalRoots;
  if (raw === undefined) return defaultCitationAllowedExternalRoots();
  if (!Array.isArray(raw) || !raw.every((root) => typeof root === 'string')) {
    return defaultCitationAllowedExternalRoots();
  }
  return raw;
}

/**
 * Whether a resolved project has a known filesystem `path` (§8.4/§8.5) — the
 * precondition for citation content-addressing to be POSSIBLE at all. When it
 * does not, `computeCitationSha` can only ever return the `"unverified"`
 * sentinel (`create-issue.ts`/`transition.ts` both short-circuit on a
 * non-string/empty `metadata.path`), so `project_policy.citationRequiresSha`
 * has nothing to gate: the gate applies only where verification is possible.
 * A path-less project therefore records `sha:"unverified"` verbatim, matching
 * the ETL's own precedent (`tools/etl/citation.ts`). Kept beside
 * {@link resolveProjectPolicy} — it reads the same resolved project row. The
 * PREDICATE itself is shared by BOTH write paths so the `create`/`transition`
 * gates never drift on WHICH projects are verifiable; the surrounding
 * `computeCitationSha` hashing body is NOT shared — it stays a per-file copy
 * in each verb (this package's established per-file-duplication convention —
 * see `transition.ts`'s own doc comment on its copy).
 *
 * A TYPE PREDICATE, not a bare `boolean`: both `computeCitationSha` call sites
 * (and the waiver log beside each gate) need the narrowed `metadata.path` as a
 * `string` immediately after the guard, and a predicate is the one form that
 * gives them that without a non-null assertion or a re-read of the same field.
 */
export function projectHasKnownPath(
  project: IResolvedProjectRow
): project is IResolvedProjectRow & {
  metadata: Record<string, unknown> & { path: string };
} {
  const path = project.metadata?.path;
  return typeof path === 'string' && path.length > 0;
}

// ---------------------------------------------------------------------------
// Registry CRUD (SPEC.md §3a, §4, §4c): `upsertProject` / `upsertComponent` /
// `upsertLocation` / `rmLocation` — the four verbs §3a names as "mounted as
// registry create/update entries (project upsert by `name`, component upsert
// by `(project,name)`, location upsert by `(component, locType, value)`,
// never a hand-rolled scan." Each is ONE `executeWriteTransaction` (`immediate`
// mode, §4c) over a hand-composed find-then-create/update against the caller's
// own `tx`, exactly the shape `mintOrResolveCatalogTx` above already
// establishes for the flat catalogs — never `GraphBackend.findOrCreateNode()`
// (§1, §4c: not race-free across concurrent writer processes).
// ---------------------------------------------------------------------------

/** Whether a `project`/`component` `meta` blob's business fields changed under an upsert (merge-not-replace, never a wholesale overwrite — §4a's own merge rule, applied identically to `delete.ts`'s `t_invalid` stamp). */
function mergeBusinessFields(
  priorMeta: Record<string, unknown>,
  patch: Record<string, unknown | undefined>
): Record<string, unknown> {
  const merged = { ...priorMeta };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export interface IUpsertProjectInput {
  /** The business key `project` is upserted by (§3a, §4). */
  name: string;
  path?: string;
  repoUrl?: string;
  monorepo?: boolean;
  description?: string;
  /** The acting agent's or person's identity (§6.3's opening rule). REQUIRED. */
  by: string;
}

export interface IUpsertProjectOutcome {
  uid: string;
  /** `false` when an existing LIVE `project` row with this `name` was found and updated in place; `true` only on a genuine first mint. */
  created: boolean;
  project: IProjectSummary;
}

/**
 * Create-or-update a `project` by `name` (§3a, §4). One `immediate`
 * transaction: find the LIVE `project` row by `name` — on a HIT, merge the
 * supplied fields into the EXISTING `meta` blob (never a wholesale replace;
 * an existing `meta.policy` — §2's per-project policy, read back by
 * {@link resolveProjectPolicy} — survives every subsequent `upsertProject`
 * untouched) and audit `'updated'`; on a MISS, mint the `project` row AND,
 * "on first creation ONLY," the reserved default `component` row named
 * `(root)` plus its `owns_project` edge, in the SAME transaction (§4) — audit
 * `'created'`. A repeat `upsertProject` against an existing project finds
 * `(root)` already live (via the existing-project branch, which never touches
 * it) and writes nothing further for it: idempotent, never a second row.
 *
 * Race-safety (§4c): the find-then-create SELECT and the INSERT/UPDATE both
 * run inside the SAME `BEGIN IMMEDIATE` transaction two concurrent processes
 * cannot both hold at once — one commits, the other's driver-level conflict
 * surfaces as `E_CONTENTION` and is retried by {@link executeWriteTransaction}
 * (250ms/500ms backoff, 3 attempts, §4c), never a racing check-then-insert.
 *
 * Errors: `InvalidArgumentError` (`name`/`by` missing or blank),
 * `WriteContentionError`/`WriteIOError` (§4c, an exhausted or unclassified
 * driver-level failure on the underlying `immediate` transaction).
 */
export async function upsertProject(
  handle: IWriteStoreHandle,
  input: IUpsertProjectInput
): Promise<IUpsertProjectOutcome> {
  assertNonBlank('name', input.name);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, (tx) =>
    upsertProjectTx(tx, handle, input)
  );
}

/**
 * Transaction-PARTICIPANT core of {@link upsertProject} — the exact body
 * that used to run inside its `executeWriteTransaction` callback, extracted
 * so a caller that already owns an open `immediate` transaction (the ETL's
 * `tools/etl/import-item.ts` bundles an entire source item's writes into ONE
 * transaction, SPEC.md §7a) can participate in it instead of nesting a
 * second `executeWriteTransaction` call — nesting would either deadlock or
 * silently open two separate transactions where one atomic one was intended.
 * `upsertProject` itself is now a thin wrapper: open the transaction, hand it
 * to this function. Same validation contract as `upsertProject` — callers of
 * THIS function are responsible for having already run `assertNonBlank`/
 * `assertNotBareRoleLiteral` on `input.name`/`input.by` (this function does
 * not re-validate, matching every other `*Tx` helper in this module).
 */
export async function upsertProjectTx(
  tx: AdapterTransaction,
  handle: Pick<IWriteStoreHandle, 'typePolicy'>,
  input: IUpsertProjectInput
): Promise<IUpsertProjectOutcome> {
  const now = nowISO();
  const existing = await tx.executeGet<{
    rowid: number;
    uid: string;
    name: string | null;
    meta: string | null;
  }>(
    "SELECT rowid, uid, name, meta FROM node WHERE kind = 'project' AND name = ? AND t_invalid IS NULL LIMIT 1",
    [input.name]
  );

  const patch = {
    path: input.path,
    repoUrl: input.repoUrl,
    monorepo: input.monorepo,
    description: input.description,
  };

  if (existing) {
    const mergedMeta = mergeBusinessFields(
      parseMetaObject(existing.meta) ?? {},
      patch
    );
    await tx.executeRun('UPDATE node SET meta = ? WHERE rowid = ?', [
      JSON.stringify(mergedMeta),
      existing.rowid,
    ]);

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: existing.rowid,
      subjectUid: existing.uid,
      subjectKind: 'project',
      actor: input.by,
      action: 'updated',
      at: now,
    });

    return {
      uid: existing.uid,
      created: false,
      project: {
        uid: existing.uid,
        name: existing.name ?? input.name,
        path: mergedMeta.path as string | undefined,
        repoUrl: mergedMeta.repoUrl as string | undefined,
        monorepo: mergedMeta.monorepo as boolean | undefined,
        description: mergedMeta.description as string | undefined,
      },
    };
  }

  // C1 (AC5, advisory half) — repoUrl de-duplication at MINT time. The
  // business key is `name`, so registering the same repository under a second
  // name would mint a second `project` and split every `owns_project` read.
  // Before minting, look for a LIVE project whose `meta.repoUrl` equals the
  // supplied one; on a hit, UPDATE that row instead (merge business fields,
  // audit `'updated'`) and return it. This is ADVISORY de-duplication, never an
  // automatic MERGE: no component is re-pointed and no row is retired — the
  // reviewed `merge-project` verb owns that. An existing drifted pair that
  // already shares a repoUrl is not rewritten here.
  if (input.repoUrl !== undefined && input.repoUrl.trim().length > 0) {
    const { rows } = await tx.executeAll<{
      rowid: number;
      uid: string;
      name: string | null;
      meta: string | null;
    }>(
      "SELECT rowid, uid, name, meta FROM node WHERE kind = 'project' AND t_invalid IS NULL ORDER BY rowid ASC"
    );
    const duplicate = rows.find(
      (row) => parseMetaObject(row.meta)?.repoUrl === input.repoUrl
    );
    if (duplicate) {
      const mergedMeta = mergeBusinessFields(
        parseMetaObject(duplicate.meta) ?? {},
        patch
      );
      await tx.executeRun('UPDATE node SET meta = ? WHERE rowid = ?', [
        JSON.stringify(mergedMeta),
        duplicate.rowid,
      ]);
      await writeAudit({
        tx,
        typePolicy: handle.typePolicy,
        subjectRowid: duplicate.rowid,
        subjectUid: duplicate.uid,
        subjectKind: 'project',
        actor: input.by,
        action: 'updated',
        note: 'repo-url-dedupe',
        at: now,
      });
      return {
        uid: duplicate.uid,
        created: false,
        project: {
          uid: duplicate.uid,
          name: duplicate.name ?? input.name,
          path: mergedMeta.path as string | undefined,
          repoUrl: mergedMeta.repoUrl as string | undefined,
          monorepo: mergedMeta.monorepo as boolean | undefined,
          description: mergedMeta.description as string | undefined,
        },
      };
    }
  }

  const metadata = mergeBusinessFields({}, patch);
  const project = await writeNodeTx(tx, {
    kind: 'project',
    name: input.name,
    metadata,
    at: now,
  });

  // First creation ONLY: the reserved default component `(root)` + its
  // `owns_project` edge, in the SAME transaction (§4, §6.1's mint-vs-throw
  // rule's own dependency — `resolveDefaultComponentTx` never mints this
  // itself, it only traverses `owns_project` to find what THIS call wrote).
  const root = await writeNodeTx(tx, {
    kind: 'component',
    name: '(root)',
    metadata: { projectUid: project.uid },
    at: now,
  });
  const ownsProjectRule = await resolveEdgeKindTx(tx, 'owns_project');
  await writeEdgeTx(tx, {
    at: now,
    srcRowid: project.rowid,
    srcUid: project.uid,
    srcKind: 'project',
    dstRowid: root.rowid,
    dstUid: root.uid,
    dstKind: 'component',
    rel: 'owns_project',
    rule: ownsProjectRule,
    typePolicy: handle.typePolicy,
  });

  await writeAudit({
    tx,
    typePolicy: handle.typePolicy,
    subjectRowid: project.rowid,
    subjectUid: project.uid,
    subjectKind: 'project',
    actor: input.by,
    action: 'created',
    at: now,
  });

  return {
    uid: project.uid,
    created: true,
    project: {
      uid: project.uid,
      name: input.name,
      path: input.path,
      repoUrl: input.repoUrl,
      monorepo: input.monorepo,
      description: input.description,
    },
  };
}

export interface IUpsertComponentInput {
  /** `project` reference — `uid` or `name` (§6.1's disambiguation-by-shape rule), resolved-ONLY, never minted. */
  project: string;
  /** The business key `component` is upserted by, scoped to `project` (§3a, §4: "upsert by `(project, name)`"). */
  name: string;
  path?: string;
  description?: string;
  /** The acting agent's or person's identity (§6.3's opening rule). REQUIRED. */
  by: string;
}

export interface IUpsertComponentOutcome {
  uid: string;
  /** `false` when an existing LIVE `component` row with this `(project, name)` was found and updated in place. */
  created: boolean;
  component: IComponentSummary;
}

/**
 * Create-or-update a `component` by `(project, name)` (§3a, §4). `project`
 * is resolved-ONLY ({@link resolveProjectTx}) — an unresolved `project`
 * throws `CatalogNotFoundError` before any component-side work runs. One
 * `immediate` transaction thereafter: find the LIVE `component` row scoped to
 * the resolved project's `uid` — on a HIT, merge the supplied fields into the
 * EXISTING `meta` (never a wholesale replace, same rule as
 * {@link upsertProject}) and audit `'updated'`; on a MISS, mint the row.
 * Either way, the `owns_project` edge (project → component, §3a's registry
 * edge set) is written with the SAME `ON CONFLICT` upsert `writeEdgeTx`
 * itself already performs — a no-op re-livening when the edge already exists,
 * so a component whose edge somehow drifted from its `meta.projectUid` (it
 * never should, both are written in the SAME transaction on creation) is
 * self-healed rather than left stale.
 *
 * Errors: `InvalidArgumentError` (`project`/`name`/`by` missing or blank),
 * `CatalogNotFoundError` (`project` does not resolve),
 * `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function upsertComponent(
  handle: IWriteStoreHandle,
  input: IUpsertComponentInput
): Promise<IUpsertComponentOutcome> {
  assertNonBlank('project', input.project);
  assertNonBlank('name', input.name);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, (tx) =>
    upsertComponentTx(tx, handle, input)
  );
}

/**
 * Transaction-PARTICIPANT core of {@link upsertComponent} — same extraction
 * rationale as {@link upsertProjectTx}: lets a caller that already owns an
 * open `immediate` transaction (the ETL) participate instead of nesting a
 * second `executeWriteTransaction`. `upsertComponent` itself is now a thin
 * wrapper: validate, open the transaction, hand it to this function. Callers
 * of THIS function are responsible for having already run the same
 * `assertNonBlank`/`assertNotBareRoleLiteral` validation `upsertComponent`
 * runs before opening its transaction.
 */
export async function upsertComponentTx(
  tx: AdapterTransaction,
  handle: Pick<IWriteStoreHandle, 'typePolicy'>,
  input: IUpsertComponentInput
): Promise<IUpsertComponentOutcome> {
  const now = nowISO();
  const project = await resolveProjectTx(tx, input.project);

  const existing = await tx.executeGet<{
    rowid: number;
    uid: string;
    name: string | null;
    meta: string | null;
  }>(
    `SELECT rowid, uid, name, meta FROM node
     WHERE kind = 'component' AND name = ? AND t_invalid IS NULL
       AND json_extract(meta, '$.projectUid') = ?
     LIMIT 1`,
    [input.name, project.uid]
  );

  const patch = { path: input.path, description: input.description };
  let componentRowid: number;
  let componentUid: string;
  let componentName: string;
  let created: boolean;
  let resultMeta: Record<string, unknown>;

  if (existing) {
    resultMeta = mergeBusinessFields(
      { ...(parseMetaObject(existing.meta) ?? {}), projectUid: project.uid },
      patch
    );
    await tx.executeRun('UPDATE node SET meta = ? WHERE rowid = ?', [
      JSON.stringify(resultMeta),
      existing.rowid,
    ]);
    componentRowid = existing.rowid;
    componentUid = existing.uid;
    componentName = existing.name ?? input.name;
    created = false;
  } else {
    resultMeta = mergeBusinessFields({ projectUid: project.uid }, patch);
    const minted = await writeNodeTx(tx, {
      kind: 'component',
      name: input.name,
      metadata: resultMeta,
      at: now,
    });
    componentRowid = minted.rowid;
    componentUid = minted.uid;
    componentName = input.name;
    created = true;
  }

  const ownsProjectRule = await resolveEdgeKindTx(tx, 'owns_project');
  await writeEdgeTx(tx, {
    at: now,
    srcRowid: project.rowid,
    srcUid: project.uid,
    srcKind: 'project',
    dstRowid: componentRowid,
    dstUid: componentUid,
    dstKind: 'component',
    rel: 'owns_project',
    rule: ownsProjectRule,
    typePolicy: handle.typePolicy,
  });

  await writeAudit({
    tx,
    typePolicy: handle.typePolicy,
    subjectRowid: componentRowid,
    subjectUid: componentUid,
    subjectKind: 'component',
    actor: input.by,
    action: created ? 'created' : 'updated',
    at: now,
  });

  return {
    uid: componentUid,
    created,
    component: {
      uid: componentUid,
      name: componentName,
      projectUid: project.uid,
      path: resultMeta.path as string | undefined,
      description: resultMeta.description as string | undefined,
    },
  };
}

const VALID_LOCATION_TYPES: readonly ILocationType[] = ['path', 'url', 'tool'];

export interface IUpsertLocationInput {
  /**
   * `component` reference — `uid` or `name` (§6.1's disambiguation-by-shape
   * rule). A bare NAME is ambiguous on its own (component names are unique
   * only WITHIN a project, §6.3.2), so a name reference REQUIRES `project`
   * to scope it; a `uid` reference never needs `project` (a documented
   * judgment call — SPEC.md §3a states the call convention
   * `upsertLocation({component, locType, value})` without a `project` field,
   * but never states how a bare component name resolves; this reading stays
   * consistent with every OTHER verb's own `project`-scoped component
   * resolution — §6.1, §6.3.2 — rather than inventing a global name-uniqueness
   * scan `resolveComponentTx` itself does not perform).
   */
  component: string;
  project?: string;
  locType: ILocationType;
  value: string;
  /** The acting agent's or person's identity (§6.3's opening rule). REQUIRED. */
  by: string;
}

export interface IUpsertLocationOutcome {
  uid: string;
  /** `false` when a LIVE `location` row with this exact `(component, locType, value)` already existed — a genuine no-op: identity IS the row's entire content, so nothing is written or audited (§4a's "never disguised as a real write" rule, `move.ts`'s stated-no-op pattern). */
  created: boolean;
  location: ILocationSummary;
}

/**
 * Create-or-find a `location` by `(component, locType, value)` (§3a, §4).
 * `component` is resolved-ONLY — by `uid` directly, or by `name` scoped to
 * `project` (see {@link IUpsertLocationInput.component}'s doc comment for the
 * resolved ambiguity). One `immediate` transaction: find a LIVE `location`
 * row with the exact triple — a HIT is a genuine no-op (the triple IS the
 * row's whole identity; there is no fourth field left to merge, unlike
 * `project`/`component`), so NOTHING is written or audited and `created:
 * false` is returned; a MISS mints the row plus its `has_location` edge
 * (component → location, §3a's registry edge set) and audits `'created'`.
 *
 * An invalidated (`rmLocation`-ed) row is never resurrected or matched here —
 * the SELECT is `t_invalid IS NULL`-scoped like every other resolution in
 * this module, so re-`upsertLocation`-ing the identical triple after an
 * `rmLocation` mints a genuinely NEW row with a NEW `uid`, leaving the
 * invalidated row's own audit trail untouched (the same bi-temporal
 * non-resurrection rule `delete.ts` documents for `issue`).
 *
 * Errors: `InvalidArgumentError` (`component`/`value`/`by` missing or blank,
 * `locType` not one of `path`/`url`/`tool`, or a bare `component` NAME given
 * without `project`), `CatalogNotFoundError` (`project`/`component` does not
 * resolve), `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function upsertLocation(
  handle: IWriteStoreHandle,
  input: IUpsertLocationInput
): Promise<IUpsertLocationOutcome> {
  assertNonBlank('component', input.component);
  assertNonBlank('value', input.value);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);
  if (!VALID_LOCATION_TYPES.includes(input.locType)) {
    throw new InvalidArgumentError(
      'locType',
      `must be one of ${VALID_LOCATION_TYPES.join(', ')}`
    );
  }

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();

    let component: IResolvedCatalogRow;
    if (isUidShaped(input.component)) {
      const row = await resolveByUidTx(tx, 'component', input.component);
      component = { rowid: row.rowid, uid: row.uid, name: row.name };
    } else {
      if (input.project === undefined || input.project.trim().length === 0) {
        throw new InvalidArgumentError(
          'component',
          'a bare component name requires "project" to disambiguate — pass a component uid instead if unavailable'
        );
      }
      const project = await resolveProjectTx(tx, input.project);
      component = await resolveComponentTx(tx, {
        projectUid: project.uid,
        ref: input.component,
      });
    }

    const existing = await tx.executeGet<{ rowid: number; uid: string }>(
      `SELECT rowid, uid FROM node
       WHERE kind = 'location' AND t_invalid IS NULL
         AND json_extract(meta, '$.componentUid') = ?
         AND json_extract(meta, '$.locType') = ?
         AND json_extract(meta, '$.value') = ?
       LIMIT 1`,
      [component.uid, input.locType, input.value]
    );

    if (existing) {
      return {
        uid: existing.uid,
        created: false,
        location: {
          uid: existing.uid,
          locType: input.locType,
          value: input.value,
          componentUid: component.uid,
        },
      };
    }

    const metadata = {
      componentUid: component.uid,
      locType: input.locType,
      value: input.value,
    };
    const location = await writeNodeTx(tx, {
      kind: 'location',
      name: input.value,
      metadata,
      at: now,
    });

    const hasLocationRule = await resolveEdgeKindTx(tx, 'has_location');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: component.rowid,
      srcUid: component.uid,
      srcKind: 'component',
      dstRowid: location.rowid,
      dstUid: location.uid,
      dstKind: 'location',
      rel: 'has_location',
      rule: hasLocationRule,
      typePolicy: handle.typePolicy,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: location.rowid,
      subjectUid: location.uid,
      subjectKind: 'location',
      actor: input.by,
      action: 'created',
      at: now,
    });

    return {
      uid: location.uid,
      created: true,
      location: {
        uid: location.uid,
        locType: input.locType,
        value: input.value,
        componentUid: component.uid,
      },
    };
  });
}

export interface IRmLocationInput {
  uid: string;
  /** The acting agent's or person's identity (§6.3's opening rule). REQUIRED. */
  by: string;
  /** Optional explanation recorded on the invalidation's audit row and merged into the location's own `meta` (mirrors `delete.ts`'s `reason`, which SPEC.md §6.3.7 requires for `issue` — kept optional here since §3a/§4 state no such requirement for `location`). */
  reason?: string;
}

export interface IRmLocationOutcome {
  uid: string;
  invalidated: true;
}

/**
 * Soft-invalidate a LIVE `location` by `uid` (§3a, §4: "invalidate"; §4c's
 * table: "invalidate-by-uid after confirming the row is live, for uniformity
 * with every other verb above"). One `immediate` transaction: resolve `uid`
 * → LIVE `location` node (`resolveByUidTx`, never a bare `getNodeByUid`, §4c)
 * → hand-composed guarded `UPDATE node SET t_invalid = ?, meta = ? WHERE
 * rowid = ?` (merging `invalidatedReason`/`invalidatedAt` into the EXISTING
 * `meta`, never a wholesale replace — the SAME shape `delete.ts` uses for
 * `issue`) → invalidate the owning `has_location` edge
 * ({@link invalidateEdgeTx}, resolved via the location's own
 * `meta.componentUid`) → `writeAudit` (action `'deleted'`, matching
 * `delete.ts`'s own vocabulary), all against the SAME `tx`.
 *
 * No `issue` node ever references a `location` directly — per §3a's fixed
 * edge table ({@link EDGE_KIND_TABLE}), `has_location` (component → location)
 * is the ONLY rel touching `location` at all — so the sole referencing edge
 * this invalidates is the owning component's own `has_location` edge; no
 * issue-side fallout exists to reconcile.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by` missing or blank),
 * `CatalogNotFoundError` (no LIVE `location` node carries `uid` — including
 * an ALREADY-`rmLocation`-ed `uid`, the same non-resurrection rule
 * {@link IUpsertLocationOutcome}'s doc comment describes),
 * `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function rmLocation(
  handle: IWriteStoreHandle,
  input: IRmLocationInput
): Promise<IRmLocationOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();
    const row = await resolveByUidTx(tx, 'location', input.uid);

    const mergedMeta = {
      ...(row.metadata ?? {}),
      ...(input.reason !== undefined
        ? { invalidatedReason: input.reason }
        : {}),
      invalidatedAt: now,
    };
    const result = await tx.executeRun(
      'UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ? AND t_invalid IS NULL',
      [now, JSON.stringify(mergedMeta), row.rowid]
    );
    if (result.rowsAffected !== 1) {
      throw new Error(
        `rmLocation: invalidate UPDATE affected ${result.rowsAffected} rows for uid="${input.uid}", expected exactly 1.`
      );
    }

    const componentUid =
      typeof row.metadata?.componentUid === 'string'
        ? row.metadata.componentUid
        : undefined;
    if (componentUid !== undefined) {
      const component = await getNodeByUidTx(tx, componentUid);
      if (component?.tInvalid === null) {
        await invalidateEdgeTx(tx, {
          srcRowid: component.rowid,
          dstRowid: row.rowid,
          rel: 'has_location',
          reason: input.reason,
          at: now,
        });
      }
    }

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: row.rowid,
      subjectUid: row.uid,
      subjectKind: 'location',
      actor: input.by,
      action: 'deleted',
      note: input.reason,
      at: now,
    });

    return { uid: row.uid, invalidated: true as const };
  });
}
