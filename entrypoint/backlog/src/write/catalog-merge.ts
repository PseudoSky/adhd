/**
 * catalog-merge.ts — one-shot, REVERSIBLE collapse of the catalog's
 * case-fragment duplicates (the same token existing as two LIVE rows that
 * differ only in case).
 *
 * ## The drift this repairs
 *
 * `query/work`'s status/priority catalogs can grow a row per SPELLING: `OPEN`
 * and `open`, `HIGH`/`high`, `MEDIUM`/`medium`. Each pair folds to one token
 * under {@link catalogNameFold} (`catalog-repair.ts`), yet each is a distinct
 * LIVE row. The read layer groups by NAME, never by fold, so:
 *
 *   - `queryIssues({filter:{status:'open'}})` misses the items pointed at a
 *     differently-cased spelling of the same token;
 *   - `priorityMatrix` splits one priority across two rows;
 *   - any consumer that groups by name double-counts.
 *
 * ## What this module does
 *
 * It groups LIVE `status` rows and LIVE `priority` rows by
 * {@link catalogNameFold} (the fold D1 already ships — never re-derived here,
 * never `SQL lower()`/`NOCASE`, which are ASCII-only and would desync from the
 * JS fold), and for every fold shared by two or more live rows it:
 *
 *   1. picks the **uppercase-spelled member as canonical, unconditionally**
 *      (owner directive — not chosen by incoming-edge count). A group with no
 *      uppercase member has ONE member renamed to uppercase; that rename is
 *      journaled so it can be reversed.
 *   2. re-points every incoming `has_status`/`has_priority` edge from each
 *      fragment onto the canonical row, inside ONE transaction
 *      (`invalidateEdgeTx` the old + `writeEdgeTx` the new).
 *   3. appends every spelling that was merged away — and, in the rename case,
 *      the spelling renamed FROM — to `canonical.meta.aliases`, so a
 *      historical audit `to`/`from` naming the old spelling still classifies
 *      (`query/views/stats.ts`'s `terminalByName` expands these — the alias
 *      map lives in DATA, never as a read-time fallback table).
 *   4. invalidates each fragment node (`t_invalid`, reversible — the fragment
 *      row is never renamed away and never deleted).
 *
 * The survivor's `rank` wins; a fragment's rank is adopted ONLY when the
 * canonical has none. Ranks are never averaged and never mass-renumbered
 * (that is the live-writer integer-renumber antipattern the `priorityMatrix`
 * read view is built to tolerate).
 *
 * ## Refusal (the `closed`/`DONE` guard)
 *
 * A fold group is the ONLY grouping this module ever trusts. Two DISTINCT
 * tokens that happen to be related — `closed` and `DONE` — fold to different
 * values and are therefore never grouped by {@link planCaseFragmentMerge}.
 * {@link applyCaseFragmentMerge} re-checks that invariant itself and REFUSES
 * (throws, changing nothing) any plan whose fragment does not fold to its
 * canonical's name, so a hand-built or buggy plan can never collapse an item
 * `closed`-to-`DONE`.
 *
 * ## Idempotent and reversible
 *
 * A store with no live case-variant group plans zero groups and writes
 * nothing. The apply journal records the fragment's full prior `meta`, the
 * exact re-pointed edges, the canonical's prior `meta`, and any rename, so
 * {@link reverseCaseFragmentMerge} restores the fragments, the original edges,
 * and reverses the rename.
 *
 * ## Not a read-layer concern
 *
 * Like D1, this repairs the SOURCE. It does not read the query layer and does
 * not change it (`isStatusTerminal`/`card.ts` stay name-blind, adhd ADR-0002
 * D5). Only `terminalByName` learns to expand the DATA alias map, because a
 * historical audit legitimately names a row that is no longer live.
 *
 * The "one logical repair, one timestamp" rule is honoured: every write in an
 * apply rides `plan.at`; every write in a reverse rides one captured
 * `nowISO()`.
 */

import type { NodeRecord } from '@adhd/sox-graph-store';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveEdgeKindTx } from './catalog.js';
import { catalogNameFold } from './catalog-repair.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  getNodeByRowidTx,
  invalidateEdgeTx,
  nowISO,
  writeEdgeTx,
} from './tx.js';

/** The two catalog kinds this repair collapses (D3's whole scope). */
type CatalogKind = 'status' | 'priority';

/** The edge rel an issue uses to point at a {@link CatalogKind} row. */
function edgeRelForKind(kind: CatalogKind): 'has_status' | 'has_priority' {
  return kind === 'status' ? 'has_status' : 'has_priority';
}

/**
 * True for a name whose canonical spelling IS its uppercase form
 * (`OPEN`, `HIGH`) — the spelling the owner directive makes canonical. A name
 * with no letters (`''`, `'123'`) is never "upper-spelled", so a group of
 * such names is handled by the rename branch (a no-op rename, since
 * `s.toUpperCase() === s`).
 */
function isUpperSpelled(name: string): boolean {
  return /\p{L}/u.test(name) && name === name.toUpperCase();
}

/**
 * Guarded `JSON.parse` for a `node.meta` column value — the same
 * degrade-on-corruption discipline as `catalog-repair.ts`'s (unexported)
 * `parseMetaObject` / `write/catalog.ts`'s: a non-JSON or non-object `meta`
 * degrades to `{}` rather than throwing a raw `SyntaxError` out of a
 * transaction callback.
 */
function parseMetaObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The string members of a `meta.aliases` value, in order — never a throw on a non-array/non-string. */
function asAliasList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

interface IRawNodeRow {
  rowid: number;
  uid: string;
  kind: string;
  name: string | null;
  meta: string | null;
}

/** The LIVE node carrying `uid`, or `null`. Reads the bare `node` table inside the caller's `tx`. */
async function getLiveNodeByUidTx(
  tx: AdapterTransaction,
  uid: string
): Promise<IRawNodeRow | null> {
  const row = await tx.executeGet<IRawNodeRow>(
    'SELECT rowid, uid, kind, name, meta FROM node WHERE uid = ? AND t_invalid IS NULL',
    [uid]
  );
  return row ?? null;
}

/** The node carrying `uid` regardless of liveness — used by reverse, which must re-liven an invalidated fragment. */
async function getNodeByUidAnyTx(
  tx: AdapterTransaction,
  uid: string
): Promise<IRawNodeRow | null> {
  const row = await tx.executeGet<IRawNodeRow>(
    'SELECT rowid, uid, kind, name, meta FROM node WHERE uid = ?',
    [uid]
  );
  return row ?? null;
}

/**
 * A planned merge: the fold groups to collapse, by uid. `groups` is EMPTY when
 * the store has no live case-variant group — the idempotency signal.
 */
export interface IMergePlan {
  groups: Array<{ canonicalUid: string; fragmentUids: string[] }>;
  at: string;
}

/**
 * One merged-away fragment, with everything needed to restore it. The
 * `fragmentMeta`/`canonicalMetaBefore` fields carry the full prior `meta`
 * objects (not just the changed keys), so reverse is byte-exact on the keys
 * this repair touches and never guesses.
 *
 * {@link canonicalMetaBefore} is the one field beyond the required shape —
 * without it a reverse cannot distinguish "canonical had no rank, adopted the
 * fragment's" from "canonical's own rank was this", and cannot remove exactly
 * the aliases this repair appended. It is OPTIONAL so a hand-authored minimal
 * journal still type-checks; a journal written by this module always includes
 * it.
 */
export interface IMergeJournalEntry {
  fragmentUid: string;
  canonicalUid: string;
  fragmentMeta: unknown;
  repointedEdges: Array<{
    srcRowid: number;
    rel: string;
    fragmentDstRowid: number;
  }>;
  /** The fragment's numeric `rank` at apply time, when it had one — the value the survivor did NOT adopt unless it had none of its own. */
  retainedRank?: number;
  /** Present only when this fragment's group had no upper-spelled member: the canonical row was renamed, and this is how to undo it. */
  renamed?: { uid: string; from: string; to: string };
  /** The canonical row's full prior `meta`, for exact reversal of the appended aliases / adopted rank. */
  canonicalMetaBefore?: unknown;
}

export interface IMergeJournal {
  entries: IMergeJournalEntry[];
  at: string;
}

/**
 * Build the collapse plan from the LIVE catalog rows. Pure over node records —
 * it never reads edges, so a fragment with more incoming edges than the
 * uppercase canonical loses anyway (owner directive: spelling decides, not
 * edge count).
 *
 * Grouping is by {@link catalogNameFold} alone. Within a fold group the
 * canonical is the (at most one) upper-spelled member, else the lowest-rowid
 * member (deterministically renamed at apply). Fragments are every other
 * member.
 */
export function planCaseFragmentMerge(
  liveStatuses: readonly NodeRecord[],
  livePriorities: readonly NodeRecord[]
): IMergePlan {
  const groups: IMergePlan['groups'] = [];

  for (const rows of [liveStatuses, livePriorities]) {
    const byFold = new Map<string, NodeRecord[]>();
    for (const row of rows) {
      const key = catalogNameFold(row.name ?? '');
      const list = byFold.get(key);
      if (list) list.push(row);
      else byFold.set(key, [row]);
    }

    for (const members of byFold.values()) {
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => a.id - b.id);
      const canonical =
        sorted.find((m) => isUpperSpelled(m.name ?? '')) ?? sorted[0]!;
      const fragmentUids = sorted
        .filter((m) => m.uid !== canonical.uid)
        .map((m) => m.uid);
      if (fragmentUids.length === 0) continue;
      groups.push({ canonicalUid: canonical.uid, fragmentUids });
    }
  }

  return { groups, at: nowISO() };
}

/** A catalog kind this repair refuses to treat as a case-group target. */
function assertMergeableKind(kind: string, uid: string): asserts kind is CatalogKind {
  if (kind !== 'status' && kind !== 'priority') {
    throw new Error(
      `applyCaseFragmentMerge: uid ${uid} is kind "${kind}" — only "status"/"priority" catalog rows are mergeable.`
    );
  }
}

/**
 * Apply the plan in ONE `executeWriteTransaction` (`BEGIN IMMEDIATE` + bounded
 * busy-only retry, §4c) — every group in the plan commits together or not at
 * all, so a refusal in a later group can never leave an earlier group half
 * merged.
 *
 * For each group: re-point every incoming catalog edge onto the canonical,
 * append the merged-away (and renamed-from) spellings to
 * `canonical.meta.aliases`, adopt the canonical's rank (a fragment's only if
 * the canonical lacks one), and invalidate each fragment with `t_invalid`.
 *
 * REFUSES (throws, rolling the whole apply back) any group whose fragment does
 * not fold to the canonical's live name, or whose kind differs — the
 * `closed`/`DONE` guard: two distinct tokens are never case-variants and can
 * never be collapsed here.
 *
 * A planned fragment that is no longer LIVE (a concurrent writer invalidated
 * it between plan and apply) is tolerated — it is skipped, exactly as D1's
 * apply re-guards each row.
 */
export async function applyCaseFragmentMerge(
  handle: IWriteStoreHandle,
  plan: IMergePlan
): Promise<IMergeJournal> {
  return executeWriteTransaction(handle, async (tx) => {
    const entries: IMergeJournalEntry[] = [];

    for (const group of plan.groups) {
      const canonical = await getLiveNodeByUidTx(tx, group.canonicalUid);
      if (!canonical) continue; // vanished between plan and apply — nothing to do
      assertMergeableKind(canonical.kind, canonical.uid);
      const rel = edgeRelForKind(canonical.kind);
      const rule = await resolveEdgeKindTx(tx, rel);
      const canonicalFold = catalogNameFold(canonical.name ?? '');
      const canonicalMetaBefore = parseMetaObject(canonical.meta);

      // First pass: validate + collect LIVE fragments (guard BEFORE any write).
      const fragments: IRawNodeRow[] = [];
      for (const fragmentUid of group.fragmentUids) {
        const fragment = await getLiveNodeByUidTx(tx, fragmentUid);
        if (!fragment) continue; // vanished — tolerant skip
        if (fragment.rowid === canonical.rowid) continue;
        if (fragment.kind !== canonical.kind) {
          throw new Error(
            `applyCaseFragmentMerge: refusing to merge uid ${fragment.uid} (kind "${fragment.kind}") into uid ${canonical.uid} (kind "${canonical.kind}") — kinds must match.`
          );
        }
        if (catalogNameFold(fragment.name ?? '') !== canonicalFold) {
          throw new Error(
            `applyCaseFragmentMerge: refusing to merge "${fragment.name ?? ''}" into "${canonical.name ?? ''}" — not a case-variant of the same token (they do not fold together).`
          );
        }
        fragments.push(fragment);
      }
      if (fragments.length === 0) continue;

      // Rename the canonical to uppercase when its group had no upper spelling.
      const canonicalName = canonical.name ?? '';
      let renamed: { uid: string; from: string; to: string } | undefined;
      const aliasesToAdd: string[] = [];
      let nextCanonicalMeta = canonicalMetaBefore;
      if (!isUpperSpelled(canonicalName)) {
        const to = canonicalName.toUpperCase();
        if (to !== canonicalName) {
          await tx.executeRun(
            'UPDATE node SET name = ? WHERE rowid = ? AND t_invalid IS NULL',
            [to, canonical.rowid]
          );
          renamed = { uid: canonical.uid, from: canonicalName, to };
          if (canonicalName.length > 0) aliasesToAdd.push(canonicalName);
        }
      }

      for (const fragment of fragments) {
        const fragmentMeta = parseMetaObject(fragment.meta);
        const fragmentRank =
          typeof fragmentMeta.rank === 'number' ? fragmentMeta.rank : undefined;

        // Re-point every incoming catalog edge (src → fragment) onto the
        // canonical. `invalidateEdgeTx` then `writeEdgeTx`, same tx.
        const { rows: edges } = await tx.executeAll<{ src: number }>(
          'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
          [fragment.rowid, rel]
        );
        const repointedEdges: IMergeJournalEntry['repointedEdges'] = [];
        for (const edge of edges) {
          await invalidateEdgeTx(tx, {
            srcRowid: edge.src,
            dstRowid: fragment.rowid,
            rel,
            reason: 'catalog-case-fragment-merge',
            at: plan.at,
          });
          const src = await getNodeByRowidTx(tx, edge.src);
          if (!src) continue; // source vanished — edge invalidated, nothing to re-point
          await writeEdgeTx(tx, {
            at: plan.at,
            srcRowid: edge.src,
            srcUid: src.uid,
            srcKind: src.kind,
            dstRowid: canonical.rowid,
            dstUid: canonical.uid,
            dstKind: canonical.kind,
            rel,
            rule,
            typePolicy: handle.typePolicy,
          });
          repointedEdges.push({
            srcRowid: edge.src,
            rel,
            fragmentDstRowid: fragment.rowid,
          });
        }

        // Rank: the survivor's wins; adopt the fragment's ONLY if it has none.
        const canonicalRank =
          typeof nextCanonicalMeta.rank === 'number'
            ? nextCanonicalMeta.rank
            : undefined;
        if (canonicalRank === undefined && fragmentRank !== undefined) {
          nextCanonicalMeta = { ...nextCanonicalMeta, rank: fragmentRank };
        }

        // Every spelling merged away becomes an alias of the survivor.
        for (const spelling of [
          fragment.name ?? '',
          ...asAliasList(fragmentMeta.aliases),
        ]) {
          if (spelling.length > 0) aliasesToAdd.push(spelling);
        }

        // Invalidate the fragment — reversible, never renamed away, never deleted.
        await tx.executeRun(
          'UPDATE node SET t_invalid = ? WHERE rowid = ? AND t_invalid IS NULL',
          [plan.at, fragment.rowid]
        );

        entries.push({
          fragmentUid: fragment.uid,
          canonicalUid: canonical.uid,
          fragmentMeta,
          repointedEdges,
          ...(fragmentRank !== undefined ? { retainedRank: fragmentRank } : {}),
          ...(renamed !== undefined ? { renamed } : {}),
          canonicalMetaBefore,
        });
      }

      // Write the survivor's meta: deduped aliases (+ any adopted rank).
      const canonicalNameFinal = renamed ? renamed.to : canonicalName;
      const existingAliases = asAliasList(nextCanonicalMeta.aliases);
      const aliases = [...existingAliases];
      let aliasesChanged = false;
      for (const spelling of aliasesToAdd) {
        if (spelling === canonicalNameFinal) continue;
        if (aliases.includes(spelling)) continue;
        aliases.push(spelling);
        aliasesChanged = true;
      }
      if (aliasesChanged) nextCanonicalMeta = { ...nextCanonicalMeta, aliases };
      const rankChanged = nextCanonicalMeta !== canonicalMetaBefore;
      if (aliasesChanged || rankChanged) {
        await tx.executeRun(
          'UPDATE node SET meta = ? WHERE rowid = ? AND t_invalid IS NULL',
          [JSON.stringify(nextCanonicalMeta), canonical.rowid]
        );
      }
    }

    return { entries, at: plan.at };
  });
}

/**
 * Reverse an applied journal in ONE `executeWriteTransaction`: re-liven each
 * fragment, restore its exact prior `meta`, re-point its original edges back
 * off the canonical, restore the canonical's prior `meta` (dropping the
 * appended aliases / adopted rank), and undo any rename.
 *
 * A fragment or canonical uid that no longer exists is skipped — the same
 * tolerant posture D1's reverse takes for a concurrently-deleted row.
 */
export async function reverseCaseFragmentMerge(
  handle: IWriteStoreHandle,
  journal: IMergeJournal
): Promise<void> {
  await executeWriteTransaction(handle, async (tx) => {
    const at = nowISO();

    // Restore canonical meta ONCE per canonical, from its recorded prior meta.
    const canonicalMetaBefore = new Map<string, unknown>();
    for (const entry of journal.entries) {
      if (
        entry.canonicalMetaBefore !== undefined &&
        !canonicalMetaBefore.has(entry.canonicalUid)
      ) {
        canonicalMetaBefore.set(entry.canonicalUid, entry.canonicalMetaBefore);
      }
    }

    for (const entry of journal.entries) {
      const fragment = await getNodeByUidAnyTx(tx, entry.fragmentUid);
      const canonical = await getNodeByUidAnyTx(tx, entry.canonicalUid);
      if (!fragment || !canonical) continue;
      assertMergeableKind(fragment.kind, fragment.uid);
      const rel = edgeRelForKind(fragment.kind);
      const rule = await resolveEdgeKindTx(tx, rel);

      for (const repointed of entry.repointedEdges) {
        await invalidateEdgeTx(tx, {
          srcRowid: repointed.srcRowid,
          dstRowid: canonical.rowid,
          rel: repointed.rel,
          reason: 'catalog-case-fragment-merge-reverse',
          at,
        });
        const src = await getNodeByRowidTx(tx, repointed.srcRowid);
        if (!src) continue;
        await writeEdgeTx(tx, {
          at,
          srcRowid: repointed.srcRowid,
          srcUid: src.uid,
          srcKind: src.kind,
          dstRowid: fragment.rowid,
          dstUid: fragment.uid,
          dstKind: fragment.kind,
          rel: repointed.rel,
          rule,
          typePolicy: handle.typePolicy,
        });
      }

      await tx.executeRun(
        'UPDATE node SET meta = ?, t_invalid = NULL WHERE rowid = ?',
        [JSON.stringify(entry.fragmentMeta ?? {}), fragment.rowid]
      );
    }

    for (const [uid, before] of canonicalMetaBefore) {
      const canonical = await getNodeByUidAnyTx(tx, uid);
      if (!canonical) continue;
      await tx.executeRun('UPDATE node SET meta = ? WHERE rowid = ?', [
        JSON.stringify(before ?? {}),
        canonical.rowid,
      ]);
    }

    for (const entry of journal.entries) {
      if (!entry.renamed) continue;
      await tx.executeRun('UPDATE node SET name = ? WHERE uid = ?', [
        entry.renamed.from,
        entry.renamed.uid,
      ]);
    }
  });
}
