/**
 * repo-migration.ts — BUG-BACKLOG-REPO-SPLIT-001 / DEBT-BACKLOG-REPO-MOVE-001
 * remediation: the dedicated `repo` mutation primitive this store never had.
 *
 * Two things make a naive move unsafe, both discovered empirically against
 * the real production store (not assumed):
 *
 *  1. `repo` lives in TWO places that can already have diverged —
 *     `node.namespace` (what every `repo`-scoped FILTER/lookup, including
 *     `findItemNode`, keys on) and `metadata.repo` (what every RENDERED
 *     `BacklogItem.repo` reads — `mapping.ts`'s `toBacklogItem`:
 *     `repo: meta.repo ?? node.namespace`). `@adhd/sox-graph-store`'s
 *     `touch()` does NOT support updating `namespace` at all (verified by
 *     reading its real implementation — the field is silently absent from
 *     the `Partial<NodeMeta>` fields it applies), so this module reaches
 *     `store.adapter.executeRun` directly for that one column — the SAME
 *     sanctioned escape hatch `structure.ts`'s `renameHumanIdNode` already
 *     uses for `content`/`content_hash` (DESIGN.md §14).
 *  2. A legacy `humanId` can collide with an id already live in the
 *     destination repo (empirically confirmed: `BUG-001..004`, `DEBT-001`,
 *     `DEBT-002`, `TASK-001`, and `FEAT-001` all independently exist under
 *     BOTH `adhd` and `PseudoSky/adhd` as of 2026-08-12). Moving one over the
 *     other unconditionally would either throw (via `findItemNode`'s
 *     `AmbiguousHumanIdError` guard, BUG-BACKLOG-HUMANID-COLLISION-001) or,
 *     worse, silently overwrite one item's identity with another's. This
 *     module resolves every collision to a fresh, deterministic id in the
 *     SAME family (mirrors `ids.ts`'s own `computeNextHumanId` `max + 1`
 *     rule) rather than ever dropping or clobbering an item.
 *
 * `planRepoMigration` is a pure read-only scan — safe to call any number of
 * times, and the exact function `migrateRepo`'s `dryRun:true` path uses, so a
 * preview can never diverge from what execution actually does. `nodeId`
 * never changes across a move (only `namespace`/`metadata.repo`/`humanId`/
 * `name`/`content` do), so every graph EDGE (DEPENDS_ON, RELATES_TO, PART_OF,
 * SUPERSEDES, SAME_AS, MEMBER_OF, ASSIGNED_TO) touching a moved item survives
 * the move automatically — there is nothing to re-link.
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type { BacklogItem, RepoMigrationItemResult, RepoMigrationPlan, RepoMigrationPlanItem, RepoMigrationResult } from '../model.js';
import { InvalidArgumentError } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { findItemNode } from './query.js';
import { withImmediateRetry } from './immediate-retry.js';
import {
  BACKLOG_ITEM_TAG,
  buildNodeContent,
  buildNodeName,
  buildTags,
  computeContentHash,
  humanIdFamily,
  humanIdKind,
  isLiveBacklogItemNode,
  toBacklogItem,
  type BacklogNodeMeta,
} from './mapping.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function metaOf(node: NodeRecord): Partial<BacklogNodeMeta> {
  return (node.metadata ?? {}) as Partial<BacklogNodeMeta>;
}

function familyNumber(humanId: string): number | undefined {
  const match = /-(\d+)$/.exec(humanId);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Pure, read-only, deterministic migration plan for every LIVE item whose
 * `namespace` is `fromRepo` — deliberately namespace-scoped (not
 * `metadata.repo`-scoped) so an item whose two repo fields have already
 * diverged (found empirically: `FEAT-001`/`FEAT-002`, `namespace:"adhd"` but
 * `metadata.repo:"PseudoSky/adhd"`) is still picked up and fully repaired,
 * not silently skipped because its rendered `repo` already "looks" correct.
 *
 * Collision resolution walks `sourceItems` in humanId order (stable,
 * reproducible across repeated calls) and, for a colliding humanId, assigns
 * the next free number in that family — tracked in an in-memory
 * `familyMaxInTarget` map seeded from `toRepo`'s REAL current max per family
 * and incremented for every rename already planned earlier in this same
 * pass, so two same-family collisions in one batch never target each other.
 */
export async function planRepoMigration(store: GraphBacklogStore, fromRepo: string, toRepo: string): Promise<RepoMigrationPlan> {
  if (typeof fromRepo !== 'string' || fromRepo.trim().length === 0) {
    throw new InvalidArgumentError('fromRepo', `backlog: planRepoMigration requires a non-empty fromRepo, received ${JSON.stringify(fromRepo)}`);
  }
  if (typeof toRepo !== 'string' || toRepo.trim().length === 0) {
    throw new InvalidArgumentError('toRepo', `backlog: planRepoMigration requires a non-empty toRepo, received ${JSON.stringify(toRepo)}`);
  }
  if (fromRepo === toRepo) {
    throw new InvalidArgumentError('toRepo', `backlog: planRepoMigration requires fromRepo and toRepo to differ (both were ${JSON.stringify(fromRepo)})`);
  }

  const sourceNodes = (await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: fromRepo })).filter(isLiveBacklogItemNode);
  const targetNodes = (await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: toRepo })).filter(isLiveBacklogItemNode);

  const targetHumanIds = new Set<string>();
  const familyMaxInTarget = new Map<string, number>();
  for (const node of targetNodes) {
    const meta = metaOf(node);
    const humanId = meta.humanId;
    if (!humanId) continue;
    targetHumanIds.add(humanId);
    const family = meta.family ?? humanIdFamily(humanId);
    const num = familyNumber(humanId);
    if (num !== undefined) familyMaxInTarget.set(family, Math.max(familyMaxInTarget.get(family) ?? 0, num));
  }

  const sorted = [...sourceNodes].sort((a, b) => (metaOf(a).humanId ?? '').localeCompare(metaOf(b).humanId ?? ''));

  // TWO PASSES, deliberately. A single greedy pass that grows `targetHumanIds`
  // as it walks `sorted` CASCADES: moving `BUG-001` onto the next free
  // `BUG-005` puts `BUG-005` in the taken-set, so the source's OWN `BUG-005`
  // — which never collided with anything — is then renamed too, and so on
  // down the family. Measured against the real production store, that turned
  // 8 genuine collisions into 43 renames. Every rename silently invalidates
  // that id everywhere it is already referenced (citations, cross-links,
  // commit messages, docs), so renaming an item that did not have to move is
  // not a cosmetic difference — it is 35 broken references.
  //
  // Pass 1 reserves every source id that is genuinely free in the target.
  // Pass 2 allocates fresh ids for the true collisions only, skipping
  // anything reserved in pass 1.
  const originalTargetIds = new Set(targetHumanIds);
  const reserved = new Set(originalTargetIds);
  const conflicted: typeof sorted = [];
  for (const node of sorted) {
    const humanId = metaOf(node).humanId ?? '';
    if (originalTargetIds.has(humanId)) conflicted.push(node);
    else reserved.add(humanId);
  }

  // Family high-water marks must account for the ids pass 1 just reserved,
  // or pass 2 would hand out an id a kept item is already sitting on.
  const familyMax = new Map<string, number>(familyMaxInTarget);
  for (const id of reserved) {
    const num = familyNumber(id);
    if (num === undefined) continue;
    const fam = humanIdFamily(id);
    familyMax.set(fam, Math.max(familyMax.get(fam) ?? 0, num));
  }

  const renames = new Map<number, string>();
  for (const node of conflicted) {
    const meta = metaOf(node);
    const family = meta.family ?? humanIdFamily(meta.humanId ?? '');
    let next = (familyMax.get(family) ?? 0) + 1;
    let candidate = `${family}-${String(next).padStart(3, '0')}`;
    while (reserved.has(candidate)) {
      next += 1;
      candidate = `${family}-${String(next).padStart(3, '0')}`;
    }
    familyMax.set(family, next);
    reserved.add(candidate);
    renames.set(node.id, candidate);
  }

  const items: RepoMigrationPlanItem[] = [];
  for (const node of sorted) {
    const meta = metaOf(node);
    const humanId = meta.humanId ?? '';
    const renamedTo = renames.get(node.id);
    items.push({
      nodeId: node.id,
      humanId,
      targetHumanId: renamedTo ?? humanId,
      renamed: renamedTo !== undefined,
      title: meta.title ?? '',
      status: meta.status ?? 'UNKNOWN',
    });
  }

  return { fromRepo, toRepo, items, collisionCount: items.filter((it) => it.renamed).length };
}

/**
 * Executes exactly ONE planned move, re-verifying the live state at the
 * exact node still matches what the plan assumed (a stale plan — the source
 * item moved/mutated, or the target humanId got claimed — since planning
 * throws `InvalidArgumentError` rather than silently proceeding on bad
 * assumptions; `executeRepoMigration` catches this per-item so one stale
 * entry never aborts the whole batch or gets silently skipped).
 *
 * Mirrors `structure.ts`'s `renameHumanIdNode` exactly, generalized to also
 * rewrite `namespace` (which `renameHumanIdNode` deliberately refuses to
 * touch — same-repo only) — see this module's top-of-file doc comment for
 * why `touch()` cannot do that column and a raw `UPDATE` is required.
 */
export async function migrateRepoItemNode(store: GraphBacklogStore, item: RepoMigrationPlanItem, fromRepo: string, toRepo: string, actor: string): Promise<BacklogItem> {
  const node = await store.graph.getNode(item.nodeId);
  if (!node || node.tInvalid || !isLiveBacklogItemNode(node)) {
    throw new InvalidArgumentError(
      'nodeId',
      `backlog: migration plan item nodeId=${item.nodeId} (humanId=${JSON.stringify(item.humanId)}) is no longer a live backlog item — re-run planRepoMigration and retry.`
    );
  }
  const meta = metaOf(node);
  if (meta.humanId !== item.humanId || node.namespace !== fromRepo) {
    throw new InvalidArgumentError(
      'nodeId',
      `backlog: migration plan for nodeId=${item.nodeId} is stale — expected (namespace=${JSON.stringify(fromRepo)}, humanId=${JSON.stringify(item.humanId)}), ` +
        `found (namespace=${JSON.stringify(node.namespace)}, humanId=${JSON.stringify(meta.humanId)}). Re-run planRepoMigration and retry.`
    );
  }
  const clash = await findItemNode(store, toRepo, item.targetHumanId);
  if (clash) {
    throw new InvalidArgumentError(
      'targetHumanId',
      `backlog: migration target humanId=${JSON.stringify(item.targetHumanId)} in repo=${JSON.stringify(toRepo)} is now claimed by ` +
        `nodeId=${clash.id} (it was free when planRepoMigration ran) — re-run planRepoMigration and retry.`
    );
  }

  const nowIso = new Date().toISOString();
  const newKind = humanIdKind(item.targetHumanId);
  const newFamily = humanIdFamily(item.targetHumanId);
  const oldReservedTags = new Set<string>([BACKLOG_ITEM_TAG, meta.kind ?? humanIdKind(item.humanId), meta.family ?? humanIdFamily(item.humanId)]);
  const userTags = node.tags.filter((t) => !oldReservedTags.has(t));

  // (BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC) ALL THREE writes run in ONE
  // `immediate` transaction. They were previously three separate awaited
  // mutations with no transaction around them, and an interruption between any
  // two left the node in exactly the split state this module exists to REPAIR:
  // `metadata.repo` saying one repo while `node.namespace` still said the
  // other. Interrupted mid-item, the repair tool manufactured a fresh instance
  // of the corruption it repairs.
  //
  // That is not theoretical here. The store this runs against has taken a
  // native turso panic twice in three days, and a native panic is uncatchable
  // from JS — "crash between step 1 and step 3" is a demonstrated event class
  // on this system, not a hypothetical one.
  //
  // `mutateMetadata` is deliberately NOT reused: it opens its own
  // `adapter.transaction(..., { mode: 'immediate' })`, and SQLite/turso cannot
  // nest BEGIN. Its body is inlined instead, so the metadata write, the
  // name/tags touch, and the raw namespace/content UPDATE either all commit or
  // all roll back. `withImmediateRetry` wraps the whole unit for the same
  // busy-contention reason mutateMetadata used it (DEBT-BACKLOG-IMMEDIATE-RETRY).
  //
  // `graph.touch` and `executeRun` both go through `store.adapter`, which is a
  // single shared connection, so they join the open transaction rather than
  // opening their own.
  await withImmediateRetry(() =>
    store.adapter.transaction(
      async () => {
        // Re-read INSIDE the transaction. The pre-flight checks above ran
        // before BEGIN, so this is the read whose state the writes are
        // actually consistent with.
        const live = await store.graph.getNode(item.nodeId);
        if (!live || live.tInvalid) {
          throw new InvalidArgumentError(
            'nodeId',
            `backlog: migration plan item nodeId=${item.nodeId} (humanId=${JSON.stringify(item.humanId)}) was invalidated between planning and commit — re-run planRepoMigration and retry.`
          );
        }
        // Node metadata is untrusted JSON off the row, so it is typed as a
        // PARTIAL and every field this function needs is defaulted explicitly —
        // the same discipline `mapping.ts`'s `toBacklogItem` uses.
        //
        // Deliberately NOT `as unknown as BacklogNodeMeta`: a double cast would
        // assert a shape nothing has verified, and would silently produce
        // `undefined` where a required string is declared. (The previous
        // `mutateMetadata<BacklogNodeMeta>` call hid exactly that lie behind an
        // unconstrained generic — inlining it made the lie visible, which is an
        // argument for fixing it here rather than reproducing it.)
        const m = metaOf(live);
        const finalTitle = m.title ?? '';
        const finalBody = m.body ?? '';

        const renameNote = item.renamed
          ? ` and renamed humanId from ${JSON.stringify(item.humanId)} to ${JSON.stringify(item.targetHumanId)} (id collision with an existing item already in ${JSON.stringify(toRepo)})`
          : '';
        const notes = [
          ...(m.notes ?? []),
          {
            by: actor,
            at: nowIso,
            text: `[repo migration] moved from repo=${JSON.stringify(fromRepo)}${renameNote} to repo=${JSON.stringify(toRepo)} — BUG-BACKLOG-REPO-SPLIT-001 / DEBT-BACKLOG-REPO-MOVE-001 reconciliation`,
          },
        ];
        // No type annotation and no cast: the spread of a partial plus these
        // overrides IS the new metadata, and `touch` takes a plain record.
        const nextMeta = {
          ...m,
          repo: toRepo,
          humanId: item.targetHumanId,
          kind: newKind,
          family: newFamily,
          notes,
          updatedAt: nowIso,
        };

        // Write 1 — metadata (repo, humanId, kind, family, notes).
        // Write 2 — name + tags. Both land through graph.touch.
        await store.graph.touch(item.nodeId, {
          metadata: nextMeta,
          name: buildNodeName(toRepo, item.targetHumanId),
          tags: buildTags(newKind, newFamily, userTags),
        });

        // Write 3 — `touch()` cannot update `namespace` (see top-of-file doc
        // comment), so this is the sanctioned raw-SQL escape hatch
        // (DESIGN.md §14), combined with the same `content`/`content_hash`
        // rewrite `renameHumanIdNode` already performs so the moved node's
        // global-uniqueness content marker (`mapping.ts`'s `buildNodeContent`)
        // matches its new (repo, humanId) identity.
        const content = buildNodeContent(toRepo, item.targetHumanId, finalTitle, finalBody);
        const res = await store.adapter.executeRun(
          `UPDATE node SET namespace = ?, content = ?, content_hash = ? WHERE rowid = ? AND t_invalid IS NULL`,
          [toRepo, content, computeContentHash(content), item.nodeId]
        );
        // The namespace write is the one that makes the move VISIBLE to every
        // repo-scoped lookup. If it matched nothing, the metadata written above
        // must not survive on its own — that is precisely the divergence this
        // module repairs. Throwing rolls the whole unit back.
        if (res.rowsAffected !== 1) {
          throw new InvalidArgumentError(
            'nodeId',
            `backlog: namespace UPDATE for nodeId=${item.nodeId} affected ${res.rowsAffected} row(s), expected exactly 1 — rolling back the whole move rather than leaving metadata.repo and node.namespace divergent.`
          );
        }
      },
      { mode: 'immediate' }
    )
  );

  const updated = await store.graph.getNode(item.nodeId);
  if (!updated) throw new InvalidArgumentError('nodeId', `backlog: migrateRepoItemNode nodeId=${item.nodeId} vanished mid-move — this should be unreachable.`);
  return toBacklogItem(updated);
}

/**
 * Executes every item in `plan`, sequentially (each rename must observe the
 * previous item's real committed state before computing/verifying the next
 * — see `planRepoMigration`'s doc comment on why this must not run in
 * parallel). Every planned item gets exactly one result — `ok:true` or
 * `ok:false` with `error` — so a failure is always visible and never
 * silently drops an item from the report; a per-item failure does not abort
 * the remaining items (an aborted batch would leave an unpredictable subset
 * moved with no way to tell which from the caller's plan alone).
 */
export async function executeRepoMigration(store: GraphBacklogStore, plan: RepoMigrationPlan, actor: string): Promise<RepoMigrationItemResult[]> {
  const results: RepoMigrationItemResult[] = [];
  for (const item of plan.items) {
    try {
      await migrateRepoItemNode(store, item, plan.fromRepo, plan.toRepo, actor);
      results.push({ nodeId: item.nodeId, fromHumanId: item.humanId, toHumanId: item.targetHumanId, renamed: item.renamed, ok: true });
    } catch (err) {
      results.push({
        nodeId: item.nodeId,
        fromHumanId: item.humanId,
        toHumanId: item.targetHumanId,
        renamed: item.renamed,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ============================================================================
// BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC — backup, resumability, reversibility
// ============================================================================
//
// The three writes inside `migrateRepoItemNode` are now one `immediate`
// transaction (see that function's doc comment) — a crash mid-item is
// provably impossible to observe as a split (metadata.repo, namespace) state;
// `repo-migration-atomicity.spec.ts` proves this by injecting failure at the
// LAST of the three writes and reopening/re-reading the row.
//
// That closes the WITHIN-item hole but not the ACROSS-item one:
// `executeRepoMigration` still runs N single-item transactions back to back
// with nothing wrapping the batch, so a crash BETWEEN item 5 and item 6
// legitimately leaves items 1-5 moved and 6..N not — that is not corruption
// (every individual item is internally consistent), but it IS an
// operator-visible partial run with no record of what state the batch was in
// or how to get back to the pre-run state. Two things fix that, deliberately
// scoped to THIS path rather than building the general mechanism tracked by
// `FEAT-BACKLOG-SNAPSHOT-001`:
//
//  1. REVERSIBLE: `createRepoMigrationBackup` snapshots, for every item the
//     plan is about to touch, every field `migrateRepoItemNode` can mutate
//     (`namespace`, `name`, `tags`, `metadata`, `content` — `content_hash` is
//     always `computeContentHash(content)`, so it never needs its own slot),
//     read BEFORE any write in the run, and writes it to a durable JSON
//     manifest under `tmp/backlog/repo-migration-backups/` (AGENTS.md §10 —
//     the canonical ephemeral-artifact root; "ephemeral" here means
//     "operator-cleaned", not "safe to lose mid-incident" — nothing else
//     deletes it). `restoreRepoMigrationBackup` replays that manifest back
//     onto the live store, one item per `immediate` transaction (the exact
//     same atomicity guarantee `migrateRepoItemNode` gets), so a botched run
//     — of ANY size, not just the crash case — can always be undone exactly.
//
//  2. RESUMABLE + DETECTABLE: the manifest is written with `completedAt`
//     absent, and only gets `completedAt` (+ a result summary) once
//     `executeRepoMigration` returns — so a manifest missing `completedAt` on
//     disk IS the crash signal, findable by `findIncompleteRepoMigrationBackups`
//     without touching the store at all. Resuming needs no special machinery
//     beyond that detection, though: because `planRepoMigration` scopes by
//     `namespace === fromRepo` (this file's own top-of-file doc comment,
//     Finding 1) and a successfully-migrated item's `namespace` is no longer
//     `fromRepo`, simply re-running `planRepoMigration` + `executeRepoMigration`
//     against the same (fromRepo, toRepo) after an interrupted run naturally
//     produces a plan containing ONLY the still-unmigrated remainder — a
//     completed item is never revisited, and there is nothing left to
//     "resume" by hand.
//
// `migrateRepo` wires both in automatically for every real (non-dry-run)
// execution: it fails CLOSED if the backup cannot be written (no migration
// proceeds without one), so there is no window where a live mutation can run
// unprotected.

/** One item's pre-migration snapshot — everything `migrateRepoItemNode` can overwrite, captured before any write in the run touches it. */
export interface IRepoMigrationBackupItem {
  nodeId: number;
  namespace: string;
  name: string;
  tags: string[];
  /** `NodeRecord.metadata` as it stood before the move — a plain object, never re-typed as `BacklogNodeMeta` (same untrusted-JSON discipline `migrateRepoItemNode` follows). */
  metadata: Record<string, unknown>;
  content: string;
}

/** One optional result-summary slot, filled in only once the guarded run has finished (successfully or not) — see `markRepoMigrationBackupComplete`. */
export interface IRepoMigrationBackupResultSummary {
  succeeded: number;
  failed: number;
}

/**
 * The on-disk snapshot for one `migrateRepo({dryRun:false})` run.
 * `completedAt`/`resultSummary` are absent from the moment the file is first
 * written until the guarded run finishes — their absence on a manifest found
 * on disk IS the "this run never finished" signal `findIncompleteRepoMigrationBackups`
 * looks for.
 */
export interface IRepoMigrationBackupManifest {
  version: 1;
  fromRepo: string;
  toRepo: string;
  actor: string;
  createdAt: string;
  completedAt?: string;
  resultSummary?: IRepoMigrationBackupResultSummary;
  items: IRepoMigrationBackupItem[];
}

export interface IRepoMigrationBackupHandle {
  backupPath: string;
  itemCount: number;
}

/** Options accepted by `migrateRepo`'s automatic backup step. */
export interface IRepoMigrationRunOptions {
  /** Directory backup manifests are written under. Defaults to `tmp/backlog/repo-migration-backups/` (AGENTS.md §10), resolved once at module load against the process's cwd at that time — mirrors `test/helpers/tmp-store.ts`'s own `TMP_ROOT` pattern. Tests should always pass an explicit dir under their own tmp store's `dir` so backups are cleaned up with everything else. */
  backupDir?: string;
}

/**
 * Default backup root. `process.cwd()` at module-load time, matching
 * `test/helpers/tmp-store.ts`'s `TMP_ROOT` — both resolve once, not per-call,
 * since a process's cwd does not change in normal operation and re-resolving
 * per call would let two calls in the same run silently disagree on where
 * the backup for THIS run lives.
 */
const DEFAULT_REPO_MIGRATION_BACKUP_DIR = join(process.cwd(), 'tmp', 'backlog', 'repo-migration-backups');

/** Repo names contain `/` (e.g. `PseudoSky/adhd`) — not valid in a filename component. */
function sanitizeRepoForFileName(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Writes `manifest` to `path` via write-then-rename so a crash mid-write can
 * never leave a half-written, unparseable JSON file behind — the temp file
 * gets an unfinished write, the RENAME is what makes the real path exist at
 * all, and a rename of a fully-written file is atomic on the same filesystem.
 */
function writeManifestAtomic(path: string, manifest: IRepoMigrationBackupManifest): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  renameSync(tmpPath, path);
}

async function captureBackupItem(store: GraphBacklogStore, nodeId: number): Promise<IRepoMigrationBackupItem> {
  const node = await store.graph.getNode(nodeId);
  if (!node) {
    throw new InvalidArgumentError(
      'nodeId',
      `backlog: cannot back up nodeId=${nodeId} before migrating it — the node no longer exists. Re-run planRepoMigration and retry.`
    );
  }
  return {
    nodeId,
    namespace: node.namespace,
    name: node.name ?? '',
    tags: [...node.tags],
    metadata: { ...(node.metadata ?? {}) },
    content: node.content,
  };
}

/**
 * Snapshots every item `plan` is about to touch, BEFORE any write in the run
 * happens, to a durable JSON manifest under `backupDir`. Read-only against
 * the store (never mutates); the manifest alone is sufficient for
 * `restoreRepoMigrationBackup` to put every item back exactly where it
 * started, and for `findIncompleteRepoMigrationBackups` to detect a run that
 * never finished.
 */
export async function createRepoMigrationBackup(
  store: GraphBacklogStore,
  plan: RepoMigrationPlan,
  actor: string,
  backupDir: string = DEFAULT_REPO_MIGRATION_BACKUP_DIR
): Promise<IRepoMigrationBackupHandle> {
  const items: IRepoMigrationBackupItem[] = [];
  for (const planItem of plan.items) {
    items.push(await captureBackupItem(store, planItem.nodeId));
  }
  const manifest: IRepoMigrationBackupManifest = {
    version: 1,
    fromRepo: plan.fromRepo,
    toRepo: plan.toRepo,
    actor,
    createdAt: new Date().toISOString(),
    items,
  };
  mkdirSync(backupDir, { recursive: true });
  const fileName = `${sanitizeRepoForFileName(plan.fromRepo)}__to__${sanitizeRepoForFileName(plan.toRepo)}-${manifest.createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  const backupPath = join(backupDir, fileName);
  writeManifestAtomic(backupPath, manifest);
  return { backupPath, itemCount: items.length };
}

/**
 * Marks `backupPath`'s manifest as belonging to a run that finished (not
 * necessarily successfully — `summary.failed` may be nonzero; the point is
 * only that `executeRepoMigration` returned rather than the process dying
 * mid-batch). Called exactly once, immediately after `executeRepoMigration`
 * returns, by `migrateRepo`.
 */
export async function markRepoMigrationBackupComplete(backupPath: string, summary: IRepoMigrationBackupResultSummary): Promise<void> {
  const manifest = JSON.parse(readFileSync(backupPath, 'utf8')) as IRepoMigrationBackupManifest;
  manifest.completedAt = new Date().toISOString();
  manifest.resultSummary = summary;
  writeManifestAtomic(backupPath, manifest);
}

/**
 * Every manifest under `backupDir` whose run never reached completion — the
 * "was a migration interrupted?" check an operator or the CLI runs before
 * trusting the store's current state, or before deciding whether to
 * `restoreRepoMigrationBackup` one back to its pre-run snapshot. Never
 * touches the store. A missing `backupDir` (nothing has ever run with backups
 * enabled) is simply "nothing incomplete", not an error.
 */
export async function findIncompleteRepoMigrationBackups(backupDir: string = DEFAULT_REPO_MIGRATION_BACKUP_DIR): Promise<IRepoMigrationBackupManifest[]> {
  if (!existsSync(backupDir)) return [];
  const manifests: IRepoMigrationBackupManifest[] = [];
  for (const file of readdirSync(backupDir)) {
    if (!file.endsWith('.json')) continue;
    const manifest = JSON.parse(readFileSync(join(backupDir, file), 'utf8')) as IRepoMigrationBackupManifest;
    if (!manifest.completedAt) manifests.push(manifest);
  }
  return manifests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Per-item outcome of replaying a backup manifest back onto the live store. */
export interface IRepoMigrationRestoreItemResult {
  nodeId: number;
  ok: boolean;
  /** Present iff `ok === false` — that one item was left as the store currently has it, never partially restored. */
  error?: string;
}

/**
 * Replays `manifest` back onto `store`, restoring every item's
 * `namespace`/`name`/`tags`/`metadata`/`content` (+ recomputed
 * `content_hash`) to exactly what `createRepoMigrationBackup` captured
 * before the guarded run touched them. Mirrors `migrateRepoItemNode`'s own
 * split — `graph.touch` for name/tags/metadata, the raw `namespace`/
 * `content`/`content_hash` `UPDATE` for the column `touch()` cannot reach —
 * with the SAME single `immediate` transaction per item, so a restore is
 * exactly as crash-safe as the migration it undoes: one item is either fully
 * put back or left exactly as the (possibly partially-migrated) store had
 * it, never split. One item's restore failing (e.g. the node was deleted
 * since the backup was taken) does not abort the rest of the batch — every
 * item in `manifest.items` gets exactly one reported outcome, mirroring
 * `executeRepoMigration`'s own never-silently-drop guarantee.
 */
export async function restoreRepoMigrationBackup(store: GraphBacklogStore, manifest: IRepoMigrationBackupManifest): Promise<IRepoMigrationRestoreItemResult[]> {
  const results: IRepoMigrationRestoreItemResult[] = [];
  for (const item of manifest.items) {
    try {
      await withImmediateRetry(() =>
        store.adapter.transaction(
          async () => {
            await store.graph.touch(item.nodeId, { metadata: item.metadata, name: item.name, tags: item.tags });
            const contentHash = computeContentHash(item.content);
            const res = await store.adapter.executeRun(`UPDATE node SET namespace = ?, content = ?, content_hash = ? WHERE rowid = ? AND t_invalid IS NULL`, [
              item.namespace,
              item.content,
              contentHash,
              item.nodeId,
            ]);
            if (res.rowsAffected !== 1) {
              throw new InvalidArgumentError(
                'nodeId',
                `backlog: restore UPDATE for nodeId=${item.nodeId} affected ${res.rowsAffected} row(s), expected exactly 1 — rolling back this item's restore rather than leaving it half-applied.`
              );
            }
          },
          { mode: 'immediate' }
        )
      );
      results.push({ nodeId: item.nodeId, ok: true });
    } catch (err) {
      results.push({ nodeId: item.nodeId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/**
 * The single entry point client.ts/CLI/MCP expose. `dryRun` defaults to
 * `true` — a caller MUST pass `dryRun:false` explicitly to mutate anything,
 * so a bare "preview this migration" call (e.g. an agent double-checking
 * before committing) can never accidentally execute.
 *
 * A real (non-dry-run) execution with at least one planned item is guarded
 * end to end: `createRepoMigrationBackup` runs FIRST and must succeed before
 * a single item is touched (fails CLOSED — if the backup cannot be written,
 * `executeRepoMigration` never runs, so there is no window where a live
 * mutation proceeds unprotected), and `markRepoMigrationBackupComplete` runs
 * LAST, once execution has returned, recording the run finished. The
 * returned object carries `backupPath` (present whenever a backup was taken)
 * as a plain extra field — `RepoMigrationResult` (model.ts, the shared v1/v2
 * contract) does not declare it, so callers typed against that interface
 * don't see it in their type checking, but it is there on the real object at
 * runtime for any caller (this module's own tests included) that wants it.
 */
export async function migrateRepo(
  store: GraphBacklogStore,
  fromRepo: string,
  toRepo: string,
  actor: string,
  dryRun = true,
  options: IRepoMigrationRunOptions = {}
): Promise<RepoMigrationResult & { backupPath?: string }> {
  const plan = await planRepoMigration(store, fromRepo, toRepo);
  if (dryRun) return { fromRepo, toRepo, dryRun: true, plan };

  const backupDir = options.backupDir ?? DEFAULT_REPO_MIGRATION_BACKUP_DIR;
  const backup = plan.items.length > 0 ? await createRepoMigrationBackup(store, plan, actor, backupDir) : undefined;

  const results = await executeRepoMigration(store, plan, actor);
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  if (backup) await markRepoMigrationBackupComplete(backup.backupPath, { succeeded, failed });

  const result = { fromRepo, toRepo, dryRun: false as const, plan, results, succeeded, failed, backupPath: backup?.backupPath };
  return result;
}
