/**
 * identity.ts — the import-audit provenance blob (task contract +
 * SPEC.md §8.2a/§8.4) and the durable crosswalk/resume-set it is rebuilt
 * from on restart.
 *
 * **Persisted provenance keys** (exact contract given for this slice):
 * `sourceProject`, `sourceRef`, `sourceFamily`, `sourcePlan`,
 * `sourceImportedFrom`, `sourceAssignee`, `sourceTags`, `sourceReporter`,
 * `sourceClaimState`, `sourceRenamedFrom`. Every one of these is written
 * when the source data has a value for it (`undefined` fields are omitted
 * by `JSON.stringify`, never serialized as `null` — matching the
 * "undefined never serialized" convention `tx.ts`'s
 * `canonicalJSONStringify` states for the audit's own `sha`-hashed fields).
 *
 * **One additional field, `sourceNodeId` — NOT one of the ten contract
 * keys, disclosed here rather than added silently.** This corpus contains a
 * real, verified anomaly: two DISTINCT source node rowids
 * (`PseudoSky/adhd::undefined-001`, filed 2026-07-25T02:30 and 02:31 —
 * "dispatch-cli --help crashes" vs. "test sourceRef parsing", both already
 * invalidated) share the exact same `(repo, sourceRef)` pair — the field the
 * frozen corpus's own JSON literally names `humanId` on disk; that raw key is
 * read in exactly one place (`corpus-types.ts`'s `IRawItemMeta.humanId`,
 * disclosed there) and renamed to `sourceRef` at that single boundary,
 * never referenced by that name anywhere else in this ETL. SPEC.md §8.4's
 * own crosswalk is keyed `${normalizedRepo}::${sourceRef}` — durable ONLY via
 * `sourceProject`/`sourceRef` scanned back out of prior audit notes (§8.7).
 * Keyed that way, a restart landing between this pair's two transactions
 * cannot tell them apart: the resume-set would contain the string key once,
 * and the second, never-imported rowid would be wrongly treated as
 * "already done" and silently skipped forever — a real, demonstrable
 * idempotency defect, not a hypothetical one. `sourceNodeId` (the source
 * store's own `rowid` — SPEC.md §8.3 itself calls this "the ETL's own join
 * key") disambiguates it while every one of the ten contract keys is still
 * present and correctly populated; this is documented here, in the run
 * report (`bugsFound`), and is the actual key this ETL's resume-set and
 * in-memory crosswalk use throughout, never the colliding string pair.
 */
import type { AllResult } from '@adhd/sox-store-adapter';
import { sourceRefOf, type IRawItemMeta } from './corpus-types.js';
import { IMPORTED_ACTION } from './constants.js';

/** The minimal read surface `scanResumeState` needs — satisfied by both `StoreAdapter` and `AdapterTransaction` without `Pick` over their union (which does not distribute the way a single-interface `Pick` would). */
export interface IReadableStore {
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
}

export interface IImportProvenance {
  sourceNodeId: number;
  sourceProject?: string;
  sourceRef?: string;
  sourceFamily?: string;
  sourcePlan?: string;
  sourceImportedFrom?: string;
  sourceAssignee?: string;
  sourceTags?: string[];
  sourceReporter?: string;
  sourceClaimState?: { claimedBy?: string; claimedAt?: string };
  sourceRenamedFrom?: Array<{ repo: string; ref: string; at: string }>;
}

/** The reserved tags `toBacklogItem` strips before computing "user tags" (store/mapping.ts:245-275) — reproduced here so `sourceTags` matches the live read path's own definition of a "user tag" exactly. */
function userTags(allTags: readonly string[], kind: string, family: string): string[] {
  const reserved = new Set<string>(['backlog-item', kind, family]);
  return allTags.filter((t) => !reserved.has(t));
}

/**
 * Builds the provenance blob for one item (task contract's exact key list +
 * `sourceNodeId`). `rawRepo` is the EFFECTIVE source `repo` value already
 * resolved through `toBacklogItem`'s own `meta.repo ?? node.namespace`
 * fallback (verbatim, pre-normalization — SPEC.md §8.4's project-name
 * normalization is a SEPARATE, later step; the provenance blob records what
 * the source data actually said).
 */
export function buildProvenance(sourceNodeId: number, rawRepo: string, tagsParsed: readonly string[], item: IRawItemMeta): IImportProvenance {
  const kind = item.kind ?? '';
  const family = item.family ?? '';
  const tags = userTags(tagsParsed, kind, family);
  const claimState = item.claimedBy !== undefined || item.claimedAt !== undefined
    ? { claimedBy: item.claimedBy, claimedAt: item.claimedAt }
    : undefined;

  const sourceRenamedFrom = item.renamedFrom?.map((r) => ({ repo: r.repo, ref: r.humanId, at: r.at }));

  return {
    sourceNodeId,
    sourceProject: rawRepo,
    sourceRef: sourceRefOf(item),
    sourceFamily: item.family,
    sourcePlan: item.plan,
    sourceImportedFrom: item.importedFrom,
    sourceAssignee: item.assignee,
    sourceTags: tags.length > 0 ? tags : undefined,
    sourceReporter: item.reporter,
    sourceClaimState: claimState,
    sourceRenamedFrom,
  };
}

export interface IResumeState {
  /** `sourceNodeId` (source store rowid) → the backlog `uid` it was already imported to, in a PRIOR run. */
  crosswalk: Map<number, string>;
  /** `sourceNodeId`s already imported — Pass 1 skips these on this run. */
  resumeSet: Set<number>;
  /** Prior-run `imported` audit nodes whose `note` did not parse as JSON, or lacked a numeric `sourceNodeId` — disclosed, never silently absorbed. */
  malformedResumeAuditNotes: number;
}

/**
 * Scans every live `audit` node with `action: 'imported'` already written by
 * a prior run (SPEC.md §8.7) and rebuilds the crosswalk/resume-set from
 * `target_uid` + the `sourceNodeId` this ETL stamps into `note`'s JSON blob
 * (see this file's own doc comment for why `sourceNodeId`, not the
 * `(sourceProject, sourceRef)` pair the base SPEC crosswalk describes, is
 * the actual key used). Run OUTSIDE any transaction — a plain autocommit
 * read, exactly as `create-issue.ts`'s own pre-resolve reads do (`adapter`
 * is a structural superset of `AdapterTransaction`).
 */
export async function scanResumeState(adapter: IReadableStore): Promise<IResumeState> {
  const { rows } = await adapter.executeAll<{ target_uid: string | null; meta: string | null }>(
    "SELECT json_extract(meta, '$.target_uid') AS target_uid, meta FROM node WHERE kind = 'audit' AND t_invalid IS NULL AND json_extract(meta, '$.action') = ?",
    [IMPORTED_ACTION],
  );
  const crosswalk = new Map<number, string>();
  const resumeSet = new Set<number>();
  let malformedResumeAuditNotes = 0;
  for (const row of rows) {
    if (!row.meta || !row.target_uid) {
      malformedResumeAuditNotes += 1;
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      const outer = JSON.parse(row.meta) as { note?: unknown };
      if (typeof outer.note !== 'string') throw new Error('note not a string');
      parsed = JSON.parse(outer.note) as Record<string, unknown>;
    } catch {
      malformedResumeAuditNotes += 1;
      continue; // A malformed prior audit note is a genuine anomaly, not this scan's job to repair.
    }
    const sourceNodeId = parsed.sourceNodeId;
    if (typeof sourceNodeId !== 'number') {
      malformedResumeAuditNotes += 1;
      continue;
    }
    crosswalk.set(sourceNodeId, row.target_uid);
    resumeSet.add(sourceNodeId);
  }
  return { crosswalk, resumeSet, malformedResumeAuditNotes };
}
