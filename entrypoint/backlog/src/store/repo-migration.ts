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

  const items: RepoMigrationPlanItem[] = [];
  for (const node of sorted) {
    const meta = metaOf(node);
    const humanId = meta.humanId ?? '';
    const family = meta.family ?? humanIdFamily(humanId);
    let targetHumanId = humanId;
    let renamed = false;
    if (targetHumanIds.has(humanId)) {
      const nextNum = (familyMaxInTarget.get(family) ?? 0) + 1;
      familyMaxInTarget.set(family, nextNum);
      targetHumanId = `${family}-${String(nextNum).padStart(3, '0')}`;
      renamed = true;
    }
    targetHumanIds.add(targetHumanId);
    items.push({
      nodeId: node.id,
      humanId,
      targetHumanId,
      renamed,
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

/**
 * The single entry point client.ts/CLI/MCP expose. `dryRun` defaults to
 * `true` — a caller MUST pass `dryRun:false` explicitly to mutate anything,
 * so a bare "preview this migration" call (e.g. an agent double-checking
 * before committing) can never accidentally execute.
 */
export async function migrateRepo(store: GraphBacklogStore, fromRepo: string, toRepo: string, actor: string, dryRun = true): Promise<RepoMigrationResult> {
  const plan = await planRepoMigration(store, fromRepo, toRepo);
  if (dryRun) return { fromRepo, toRepo, dryRun: true, plan };
  const results = await executeRepoMigration(store, plan, actor);
  const succeeded = results.filter((r) => r.ok).length;
  return { fromRepo, toRepo, dryRun: false, plan, results, succeeded, failed: results.length - succeeded };
}
