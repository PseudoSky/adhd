/**
 * repo-nodes.spec.ts — EPIC-A / FEAT-BACKLOG-004 acceptance.
 *
 * The bug under test is measurable, not hypothetical: this store already
 * holds items filed under BOTH `adhd` and `PseudoSky/adhd`
 * (repo-migration.ts:20-24 records `BUG-001..004`, `DEBT-001`, `DEBT-002`,
 * `TASK-001` and `FEAT-001` all existing under both), and today's repo filter
 * is `nodeFilter.namespace = filter.repo` (query.ts:49) — an exact string
 * match that silently returns half the repository's items.
 *
 * Every test below drives REAL components: a real store on disk (turso
 * substrate, `openTmpStore`), items filed through the real `createItemNode`,
 * and repo/package resolution through the real graph. Nothing is mocked. The
 * assertions are consumer-visible outcomes — "which items come back for this
 * repo key" — not implementation shape.
 *
 * TEETH: `AC-7 union` fails if the fork-key fold-in is reverted (proven by
 * negative control: breaking `decideRepository`'s fold branch so each spelling
 * mints its own node turns the union test RED, exit 1; restoring it returns
 * exit 0). Persistence is proven by CLOSING and REOPENING the store, never by
 * trusting the in-process handle. No sleeps, no wall-clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { NodeRecord } from '@adhd/sox-graph-store';
import { openGraphBacklogStore, closeGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { join } from 'node:path';
import { createItemNode } from './crud.js';
import { InvalidArgumentError, normalizeRepoKey as modelNormalizeRepoKey } from '../model.js';
import {
  BACKLOG_EDGE_RELS,
  REL_IN_REPO,
  backlogTypePolicy,
  canonicalRepoKey,
  findItemNodesInRepository,
  linkItemToPackage,
  linkItemToRepository,
  listRepositoryNodes,
  lookupRepository,
  normalizePackagePath,
  parseRepoKey,
  packagesOfRepository,
  queryItemsInRepository,
  repositoryOfItem,
  resolvePackage,
  resolveRepository,
  setRepositoryFork,
} from './repo-nodes.js';

/** Files one real item and links it to its repository node — the shape a v2 create will have. */
async function fileLinkedItem(store: GraphBacklogStore, repo: string, family: string, title: string): Promise<number> {
  const outcome = await createItemNode(store, {
    family,
    title,
    body: `body for ${title}`,
    repo,
    // `force` skips the FTS dedupe scan so the fixture is deterministic and
    // never suppressed by an unrelated title similarity.
    force: true,
  });
  expect(outcome.created).toBe(true);
  await linkItemToRepository(store, outcome.item.nodeId, repo);
  return outcome.item.nodeId;
}

function humanIds(items: { humanId: string }[]): string[] {
  return items.map((it) => it.humanId).sort();
}

/** The node behind `nodeId`, or a loud failure — a silently-absent node would make an assertion vacuous. */
async function requireNode(store: GraphBacklogStore, nodeId: number): Promise<NodeRecord> {
  const node = await store.graph.getNode(nodeId);
  if (!node) throw new Error(`test fixture: node ${nodeId} disappeared`);
  return node;
}

/** The humanId the real create path stamped on `nodeId`. */
async function humanIdOf(store: GraphBacklogStore, nodeId: number): Promise<string> {
  const meta = (await requireNode(store, nodeId)).metadata as { humanId?: string } | undefined;
  if (!meta?.humanId) throw new Error(`test fixture: node ${nodeId} carries no humanId`);
  return meta.humanId;
}

describe('repo-nodes — repository identity as a first-class node (EPIC-A / FEAT-BACKLOG-004)', () => {
  let dir: string;
  let dbPath: string;
  let store: GraphBacklogStore | undefined;

  /** The store the current test owns — a missing one is a fixture bug, never something to assert around. */
  function activeStore(): GraphBacklogStore {
    if (!store) throw new Error('test fixture: no open store');
    return store;
  }

  beforeEach(async () => {
    dir = freshTmpDir('repo-nodes');
    dbPath = join(dir, 'backlog.db');
    store = await openGraphBacklogStore(dbPath);
  });

  afterEach(async () => {
    if (store) await closeGraphBacklogStore(store);
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Deterministic normalization (GRAPH_MODEL_v2.md §3)
  // -------------------------------------------------------------------------

  it('normalizes every real spelling of one remote to the same qualified key', () => {
    for (const raw of [
      'PseudoSky/adhd',
      'PseudoSky/adhd.git',
      'https://github.com/PseudoSky/adhd',
      'https://github.com/PseudoSky/adhd.git',
      'git@github.com:PseudoSky/adhd.git',
      '  PseudoSky/adhd/  ',
    ]) {
      expect(parseRepoKey(raw), raw).toEqual({ qualified: 'PseudoSky/adhd', bare: 'adhd', owner: 'PseudoSky' });
      expect(canonicalRepoKey(raw), raw).toBe('adhd');
    }
    expect(parseRepoKey('adhd')).toEqual({ qualified: 'adhd', bare: 'adhd', owner: undefined });
    expect(normalizePackagePath('./entrypoint//backlog/')).toBe('entrypoint/backlog');
  });

  it('rejects a key that normalizes away to nothing rather than minting an empty repository', () => {
    expect(() => parseRepoKey('')).toThrow(InvalidArgumentError);
    expect(() => parseRepoKey('   ')).toThrow(InvalidArgumentError);
    expect(() => parseRepoKey('/')).toThrow(InvalidArgumentError);
  });

  // -------------------------------------------------------------------------
  // The widened rel vocabulary is load-bearing, and scoped
  // -------------------------------------------------------------------------

  it('IN_REPO is rejected by the store default policy and accepted by the backlog policy', async () => {
    const s = activeStore();
    const repoNode = await resolveRepository(s, 'adhd');
    const itemNodeId = await fileLinkedItem(s, 'adhd', 'BUG-VOCAB', 'vocabulary probe item');

    // The DEFAULT policy handle must still refuse the new rel — this is what
    // makes `dimensionGraph`'s widened policy load-bearing rather than
    // decorative. If this ever stops throwing, the scoping claim in
    // repo-nodes.ts's header is stale.
    await expect(s.graph.writeEdge(itemNodeId, repoNode.node.nodeId, REL_IN_REPO)).rejects.toThrow(/IN_REPO/);
    expect(BACKLOG_EDGE_RELS).toContain(REL_IN_REPO);
    expect(() => backlogTypePolicy.validateRel(REL_IN_REPO)).not.toThrow();
    expect(() => backlogTypePolicy.validateRel('NOT_A_REL')).toThrow(InvalidArgumentError);

    // ...and the edge the dimension handle wrote is readable back.
    expect(await repositoryOfItem(s, itemNodeId)).toMatchObject({ canonicalKey: 'adhd' });
  });

  // -------------------------------------------------------------------------
  // AC-7 — the measured bug
  // -------------------------------------------------------------------------

  it('AC-7: a single-key query returns the union of BOTH fork keys and no foreign-repo items', async () => {
    const s = activeStore();
    const bare = await fileLinkedItem(s, 'adhd', 'BUG-FORK', 'item filed under the bare key');
    const qualified = await fileLinkedItem(s, 'PseudoSky/adhd', 'BUG-FORK', 'item filed under the qualified key');
    const foreign = await fileLinkedItem(s, 'sox-ecosystem', 'BUG-FORK', 'item belonging to a different repository');

    // Baseline: today's exact-string namespace filter (query.ts:49) sees only
    // half the repository. This is the defect, reproduced.
    const legacyNamespaceScan = await s.graph.queryNodes({ kind: 'generic', tags: ['backlog-item'], namespace: 'adhd' });
    expect(legacyNamespaceScan.map((n) => n.id)).toEqual([bare]);

    // Both spellings resolve to ONE canonical node...
    const viaBare = await queryItemsInRepository(s, 'adhd');
    const viaQualified = await queryItemsInRepository(s, 'PseudoSky/adhd');
    const viaUrl = await queryItemsInRepository(s, 'git@github.com:PseudoSky/adhd.git');
    expect(viaBare.repository?.nodeId).toBe(viaQualified.repository?.nodeId);
    expect(viaUrl.repository?.nodeId).toBe(viaBare.repository?.nodeId);
    expect(viaBare.repository?.canonicalKey).toBe('adhd');
    // `aliases` holds every OTHER spelling and never the canonical key itself
    // (model.ts:1871) — the union below is what proves both keys resolve here.
    expect(viaBare.repository?.aliases.sort()).toEqual(['PseudoSky/adhd']);

    // ...and every spelling returns the SAME union.
    const expected = [await humanIdOf(s, bare), await humanIdOf(s, qualified)].sort();
    expect(humanIds(viaBare.items)).toEqual(expected);
    expect(humanIds(viaQualified.items)).toEqual(expected);
    expect(humanIds(viaUrl.items)).toEqual(expected);

    // No foreign-repo item leaks in, in either direction.
    expect(viaBare.items.map((it) => it.nodeId)).not.toContain(foreign);
    const foreignScan = await queryItemsInRepository(s, 'sox-ecosystem');
    expect(foreignScan.items.map((it) => it.nodeId)).toEqual([foreign]);
  });

  it('AC-7: the IN_REPO edge leg ALONE carries the union — the answer is in the graph, not the strings', async () => {
    const s = activeStore();
    const bare = await fileLinkedItem(s, 'adhd', 'BUG-EDGE', 'edge-leg bare item');
    const qualified = await fileLinkedItem(s, 'PseudoSky/adhd', 'BUG-EDGE', 'edge-leg qualified item');
    await fileLinkedItem(s, 'sox-ecosystem', 'BUG-EDGE', 'edge-leg foreign item');

    // Legacy string leg disabled: only `IN_REPO` edges can answer now. This is
    // the post-backfill shape, asserted today.
    const edgeOnly = await findItemNodesInRepository(s, 'adhd', { includeLegacyAliasMatch: false });
    expect(edgeOnly.nodes.map((n) => n.id).sort((a, b) => a - b)).toEqual([bare, qualified].sort((a, b) => a - b));
  });

  it('an unknown repo key returns nothing and mints nothing — a query is not a write', async () => {
    const s = activeStore();
    await fileLinkedItem(s, 'adhd', 'BUG-UNKNOWN', 'an item in a known repository');
    const before = await listRepositoryNodes(s);

    const scan = await queryItemsInRepository(s, 'some-repo-nobody-has-heard-of');
    expect(scan.repository).toBeNull();
    expect(scan.items).toEqual([]);
    expect(await lookupRepository(s, 'some-repo-nobody-has-heard-of')).toBeNull();
    expect(await listRepositoryNodes(s)).toHaveLength(before.length);
  });

  it('the legacy repo strings are untouched — both models coexist until the backfill is verified', async () => {
    const s = activeStore();
    const nodeId = await fileLinkedItem(s, 'PseudoSky/adhd', 'BUG-COEXIST', 'coexistence item');
    const node = await requireNode(s, nodeId);
    // The node still carries the EXACT string it was filed under, in both
    // places, and the canonical key did not overwrite either.
    expect(node.namespace).toBe('PseudoSky/adhd');
    expect((node.metadata as { repo: string }).repo).toBe('PseudoSky/adhd');
    expect((await repositoryOfItem(s, nodeId))?.canonicalKey).toBe('adhd');
  });

  // -------------------------------------------------------------------------
  // AC-24 — ambiguity is never silent
  // -------------------------------------------------------------------------

  it('AC-24: two genuinely different repos sharing a bare name stay separate, and the bare key warns', async () => {
    const s = activeStore();
    const mine = await fileLinkedItem(s, 'PseudoSky/adhd', 'BUG-AMB', 'item in my adhd');
    const theirs = await fileLinkedItem(s, 'otherorg/adhd', 'BUG-AMB', 'item in a different adhd');

    const repos = await listRepositoryNodes(s);
    expect(repos.map((r) => r.canonicalKey).sort()).toEqual(['adhd', 'otherorg/adhd']);

    // Qualified keys narrow exactly, with no warning and no cross-contamination.
    const minesScan = await queryItemsInRepository(s, 'PseudoSky/adhd');
    const theirsScan = await queryItemsInRepository(s, 'otherorg/adhd');
    expect(minesScan.items.map((it) => it.nodeId)).toEqual([mine]);
    expect(theirsScan.items.map((it) => it.nodeId)).toEqual([theirs]);
    expect(minesScan.warnings).toEqual([]);
    expect(theirsScan.warnings).toEqual([]);

    // The BARE key still resolves (ok:true, real items) but must say so.
    const bareScan = await queryItemsInRepository(s, 'adhd');
    expect(bareScan.items.map((it) => it.nodeId)).toEqual([mine]);
    expect(bareScan.warnings).toHaveLength(1);
    expect(bareScan.warnings[0]).toContain('ambiguous');
    expect(bareScan.warnings[0]).toContain('"otherorg/adhd"');
    expect(bareScan.warnings[0]).toContain('Resolved to "adhd"');
  });

  // -------------------------------------------------------------------------
  // Packages
  // -------------------------------------------------------------------------

  it('packages are first-class nodes linked to their repository, addressable through any repo alias', async () => {
    const s = activeStore();
    const itemNodeId = await fileLinkedItem(s, 'PseudoSky/adhd', 'BUG-PKG', 'an item scoped to a package');
    const linked = await linkItemToPackage(s, itemNodeId, {
      repo: 'adhd',
      path: './entrypoint//backlog/',
      projectName: 'backlog',
    });
    expect(linked.node.path).toBe('entrypoint/backlog');
    expect(linked.node.repo).toBe('adhd');
    expect(linked.repository.canonicalKey).toBe('adhd');

    // Same package, addressed through the OTHER repo spelling and without the
    // project name: one node, and the known project name is not erased.
    const again = await resolvePackage(s, { repo: 'PseudoSky/adhd', path: 'entrypoint/backlog' });
    expect(again.created).toBe(false);
    expect(again.node.nodeId).toBe(linked.node.nodeId);
    expect(again.node.projectName).toBe('backlog');

    const packages = await packagesOfRepository(s, 'git@github.com:PseudoSky/adhd.git');
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ path: 'entrypoint/backlog', projectName: 'backlog', repo: 'adhd' });
  });

  // -------------------------------------------------------------------------
  // Fork edge
  // -------------------------------------------------------------------------

  it('forkOf records a real repo→repo edge and refuses a self-fork', async () => {
    const s = activeStore();
    const { fork, upstream } = await setRepositoryFork(s, 'myorg/adhd-fork', 'PseudoSky/adhd');
    expect(fork.forkOf).toBe(upstream.canonicalKey);
    expect(upstream.canonicalKey).toBe('adhd');

    await expect(setRepositoryFork(s, 'adhd', 'PseudoSky/adhd')).rejects.toThrow(InvalidArgumentError);
  });

  // -------------------------------------------------------------------------
  // Persistence — proven by REOPENING the store
  // -------------------------------------------------------------------------

  it('the whole model survives a close/reopen: aliases, item edges, packages, fork', async () => {
    const s = activeStore();
    const bare = await fileLinkedItem(s, 'adhd', 'BUG-REOPEN', 'reopen bare item');
    const qualified = await fileLinkedItem(s, 'PseudoSky/adhd', 'BUG-REOPEN', 'reopen qualified item');
    const foreign = await fileLinkedItem(s, 'sox-ecosystem', 'BUG-REOPEN', 'reopen foreign item');
    await linkItemToPackage(s, qualified, { repo: 'adhd', path: 'entrypoint/backlog', projectName: 'backlog' });
    await setRepositoryFork(s, 'myorg/adhd-fork', 'adhd');

    await closeGraphBacklogStore(s);
    store = undefined;

    // A genuinely fresh handle on the same file — nothing in memory carries
    // over, so anything asserted below came off disk.
    const reopened = await openGraphBacklogStore(dbPath);
    store = reopened;

    const scan = await queryItemsInRepository(reopened, 'PseudoSky/adhd');
    expect(scan.repository?.canonicalKey).toBe('adhd');
    expect(scan.repository?.aliases.sort()).toEqual(['PseudoSky/adhd']);
    expect(scan.items.map((it) => it.nodeId).sort((a, b) => a - b)).toEqual([bare, qualified].sort((a, b) => a - b));
    expect(scan.items.map((it) => it.nodeId)).not.toContain(foreign);

    const edgeOnly = await findItemNodesInRepository(reopened, 'adhd', { includeLegacyAliasMatch: false });
    expect(edgeOnly.nodes.map((n) => n.id).sort((a, b) => a - b)).toEqual([bare, qualified].sort((a, b) => a - b));

    expect(await packagesOfRepository(reopened, 'adhd')).toMatchObject([{ path: 'entrypoint/backlog', projectName: 'backlog' }]);
    const forkNode = (await listRepositoryNodes(reopened)).find((r) => r.canonicalKey === 'adhd-fork');
    expect(forkNode?.forkOf).toBe('adhd');
    expect(await repositoryOfItem(reopened, qualified)).toMatchObject({ canonicalKey: 'adhd' });
  });

  it('resolving the same repo repeatedly is idempotent — one node, no alias churn', async () => {
    const s = activeStore();
    const spellings = ['adhd', 'PseudoSky/adhd', 'https://github.com/PseudoSky/adhd.git', 'adhd', 'PseudoSky/adhd'];
    const ids = new Set<number>();
    for (const spelling of spellings) ids.add((await resolveRepository(s, spelling)).node.nodeId);
    expect(ids.size).toBe(1);
    const repos = await listRepositoryNodes(s);
    expect(repos).toHaveLength(1);
    expect(repos.map((r) => r.canonicalKey)).toEqual(['adhd']);
    expect(repos.map((r) => [...r.aliases].sort())).toEqual([['PseudoSky/adhd']]);
  });

  // -------------------------------------------------------------------------
  // Cross-module convergence with epic-a-backfill.ts
  // -------------------------------------------------------------------------

  // REMOVED (was: 'converges on the SAME repository node the backfill mints
  // — no dimension split-brain'). It proved that `PROVISIONAL_REPO_NODES_API`
  // (epic-a-backfill.ts) and this module's own `resolveRepository`/
  // `listRepositoryNodes` agreed on the same node — meaningful when they were
  // TWO INDEPENDENT implementations that could silently drift (the whole
  // fork-key defect class this file exists to fix, recreated one layer up).
  //
  // As of the fork-key swap, `PROVISIONAL_REPO_NODES_API.canonicalRepoKeyFor`
  // and `.listRepositoryNodes` are no longer a second implementation — they
  // call THIS module's `resolveRepository`/`lookupRepository`/
  // `listRepositoryNodes` directly (see epic-a-backfill.ts's own doc comment
  // on `PROVISIONAL_REPO_NODES_API`). "Convergence" is now true by
  // construction (one function calling itself through a thin port), not by
  // two writers agreeing, so the test would be asserting a tautology —
  // exactly the "now-meaningless green test" this rewrite was told not to
  // leave in place. It is removed rather than kept as a passing no-op.

  it('agrees with model.ts on the canonical key', async () => {
    // Two implementations of GRAPH_MODEL §3 normalization exist in this
    // package (this module's `canonicalRepoKey` and model.ts's
    // `normalizeRepoKey`); if they ever disagree, code paths that consult one
    // vs. the other will place the same raw key on different nodes. These
    // remain two genuinely independent implementations, so this comparison
    // still has teeth.
    for (const raw of [
      'adhd',
      'PseudoSky/adhd',
      'PseudoSky/adhd.git',
      'https://github.com/PseudoSky/adhd.git',
      'git@github.com:PseudoSky/adhd.git',
      'sox-ecosystem',
    ]) {
      expect(canonicalRepoKey(raw), raw).toBe(modelNormalizeRepoKey(raw));
    }
  });

  // REMOVED (second half of the former "...and writes where the backfill
  // looks" test): it queried `BACKLOG_REPO_TAG`/`BACKLOG_DIMENSION_NAMESPACE`
  // re-exported from epic-a-backfill.ts under local aliases
  // (`BACKFILL_REPO_TAG`/`BACKFILL_DIMENSION_NAMESPACE`) to prove "the
  // backfill scans where this module writes." As of the fork-key swap,
  // epic-a-backfill.ts no longer defines its own copies of those constants —
  // it re-exports THIS module's own `BACKLOG_REPO_TAG`/
  // `BACKLOG_DIMENSION_NAMESPACE` verbatim (see epic-a-backfill.ts's
  // `export { BACKLOG_DIMENSION_KIND, BACKLOG_DIMENSION_NAMESPACE,
  // BACKLOG_PACKAGE_TAG, BACKLOG_REPO_TAG, packageKeyFor };`). So that
  // assertion was comparing a constant to itself through an import alias —
  // the same tautology-after-the-swap reasoning that removed the sibling
  // "converges on the SAME repository node" test above. It is removed here
  // too, rather than left as a passing no-op, for the identical reason.

  it('linking a node that is not a live backlog item is refused, not silently edged', async () => {
    const s = activeStore();
    const repo = await resolveRepository(s, 'adhd');
    await expect(linkItemToRepository(s, repo.node.nodeId, 'adhd')).rejects.toThrow(InvalidArgumentError);
    await expect(linkItemToRepository(s, 999_999, 'adhd')).rejects.toThrow(InvalidArgumentError);
  });
});
