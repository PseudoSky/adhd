/**
 * query.spec.ts — INTERFACE_v2 §2 `backlog_query`, driven through its REAL
 * seam against a REAL store.
 *
 * Every test here opens a real turso-backed store under `tmp/backlog/`
 * (`openTmpStore`), files real items with the real `createItemNode`, moves
 * them with the real `transitionStatusNode`/`claimItemNode`/
 * `addDependencyNode`/`attachToPlanNode`, and then calls `backlogQuery` the
 * way a host does. Nothing is mocked: AGENTS.md §7's "verify the consumer
 * outcome through REAL components" is the whole point, because the defects
 * this layer exists to prevent (a page boundary drawn before a post-filter, a
 * projection that quietly ships 90KB of bodies) are invisible to a unit test
 * that stubs the store out.
 *
 * The fixture teardown lives in `afterEach`, which vitest runs even when the
 * test body throws — AGENTS.md's "a test that mutates state must restore it in
 * a finally, so a FAILING run still cleans up".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKLOG_EXIT_CODE,
  exitCodeForEnvelope,
  isOutcomeError,
  isOutcomeOk,
  type BacklogStatus,
  type IBacklogCard,
  type IOutcomeEnvelope,
  type Priority,
} from '../model.js';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from '../store/crud.js';
import { claimItemNode } from '../store/claim.js';
import { transitionStatusNode } from '../store/lifecycle.js';
import { addDependencyNode, attachToPlanNode, splitItemNode } from '../store/structure.js';
import { mutateMetadata } from '../store/mutate-metadata.js';
import { findItemNode, spotlight, staleClaims, topoOrder } from '../store/query.js';
import type { BacklogNodeMeta } from '../store/mapping.js';
import { backlogQuery, type IBacklogQueryResult } from './query.js';

const REPO = 'PseudoSky/query-v2';
const BY = 'query-v2-spec';
const CITATION = [{ file: 'entrypoint/backlog/src/v2/query.ts', lines: '1-10', context: 'query-v2-spec' }];

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('v2-query-spec');
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Fixture helpers — real writes only.
// ---------------------------------------------------------------------------

interface ISeedOptions {
  family?: string;
  repo?: string;
  title?: string;
  body?: string;
  priority?: Priority;
  plan?: string;
  projectPath?: string;
}

async function seed(opts: ISeedOptions = {}): Promise<string> {
  const input: Parameters<typeof createItemNode>[1] = {
    family: opts.family ?? 'BUG-QV2',
    title: opts.title ?? 'seeded item',
    body: opts.body ?? 'seeded body',
    repo: opts.repo ?? REPO,
    // `force` is the shipped "file anyway" override (model.ts
    // `CreateItemInput.force`). A fixture MUST get the row it asked for: the
    // real `dedupeScan` collapses near-identical titles, which silently
    // returns the canonical item instead of a new one — a fixture built on
    // that would assert against a set it never actually created.
    force: true,
  };
  if (opts.priority) input.priority = opts.priority;
  if (opts.plan) input.plan = opts.plan;
  if (opts.projectPath) input.projectPath = opts.projectPath;
  const result = await createItemNode(tmp.store, input);
  if (!result.created) throw new Error(`fixture: create was suppressed for ${JSON.stringify(input.title)} (${result.item.humanId})`);
  return result.item.humanId;
}

/** Closes an item through the REAL lifecycle gate (a terminal transition without a citation is refused — model.ts:75). */
async function close(humanId: string, repo = REPO, status: BacklogStatus = 'RESOLVED'): Promise<void> {
  await transitionStatusNode(tmp.store, repo, humanId, status, { by: BY, citations: CITATION });
}

/** Writes an axis FEAT-012/FEAT-013/§5a.3 will own, the way those epics will: straight onto the item node's metadata. */
async function setMeta(humanId: string, patch: Record<string, unknown>, repo = REPO): Promise<void> {
  const node = await findItemNode(tmp.store, repo, humanId);
  if (!node) throw new Error(`fixture: ${humanId} not found in ${repo}`);
  await mutateMetadata<BacklogNodeMeta & Record<string, unknown>>(tmp.store, node.id, (meta) => ({ ...meta, ...patch }));
}

async function claim(humanId: string, by: string, repo = REPO): Promise<void> {
  const node = await findItemNode(tmp.store, repo, humanId);
  if (!node) throw new Error(`fixture: ${humanId} not found in ${repo}`);
  await claimItemNode(tmp.store, node.id, by);
}

function ok(env: IOutcomeEnvelope<IBacklogQueryResult>): IBacklogQueryResult {
  if (!isOutcomeOk(env)) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

function ids(cards: readonly IBacklogCard[] | undefined): string[] {
  return (cards ?? []).map((c) => c.humanId);
}

// ---------------------------------------------------------------------------
// §2.1 / BUG-BACKLOG-003 — pagination composes with the filters, or it is a bug.
// ---------------------------------------------------------------------------

describe('§2.1 pagination composition (BUG-BACKLOG-003)', () => {
  /**
   * The exact shape of the shipped bug: the six items that sort FIRST in the
   * store's own insertion order are closed, so a page boundary drawn before
   * the open/closed filter returns zero open rows while six open rows exist.
   */
  it('a limited page of open items returns LIMIT open items, and meta.total is the true open count (AC-25)', async () => {
    const closed: string[] = [];
    for (let i = 0; i < 6; i += 1) closed.push(await seed({ family: 'BUG-PAGE', title: `closed ${i}`, priority: 'HIGH' }));
    for (const id of closed) await close(id);
    const open: string[] = [];
    for (let i = 0; i < 6; i += 1) open.push(await seed({ family: 'BUG-PAGE', title: `open ${i}`, priority: 'HIGH' }));

    const env = await backlogQuery(tmp.store, { filter: { repo: REPO, status: 'open' }, limit: 5 });
    const data = ok(env);

    // The consumer-visible outcome: five OPEN cards, not "five rows of which
    // some were filtered away after the page was cut".
    expect(data.items).toHaveLength(5);
    expect(ids(data.items).every((id) => open.includes(id))).toBe(true);
    expect(isOutcomeOk(env) && env.meta).toEqual({ total: 6, returned: 5, limit: 5 });
  });

  it('offset pages the SAME ordering the first page came from — no gap, no duplicate', async () => {
    const created: string[] = [];
    for (let i = 0; i < 6; i += 1) created.push(await seed({ family: 'BUG-OFF', title: `item ${i}`, priority: 'MEDIUM' }));
    await close(created[0] as string);
    await close(created[1] as string);

    const page1 = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, status: 'open' }, limit: 2, offset: 0 }));
    const page2 = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, status: 'open' }, limit: 2, offset: 2 }));
    const rest = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, status: 'open' }, offset: 4 }));

    const paged = [...ids(page1.items), ...ids(page2.items), ...ids(rest.items)];
    expect(new Set(paged).size).toBe(paged.length); // no duplicate across page boundaries
    expect(new Set(paged)).toEqual(new Set(created.slice(2)));
  });

  it('MAX_QUERY_LIMIT is a validation error, never a silent cap', async () => {
    const env = await backlogQuery(tmp.store, { limit: 5000 });
    expect(isOutcomeError(env) && env.error.code).toBe('validation');
    expect(exitCodeForEnvelope(env)).toBe(BACKLOG_EXIT_CODE.validation);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — view:list absorbs list-items AND spotlight.
// ---------------------------------------------------------------------------

describe('AC-5 view:"list" default sort IS spotlight ordering', () => {
  it('the prioritised cards come back in exactly spotlight\'s order, and the unprioritised item is kept (not silently dropped)', async () => {
    await seed({ family: 'BUG-SPOT', title: 'low', priority: 'LOW' });
    await seed({ family: 'BUG-SPOT', title: 'critical', priority: 'CRITICAL' });
    await seed({ family: 'BUG-SPOT', title: 'medium', priority: 'MEDIUM' });
    await seed({ family: 'BUG-SPOT', title: 'high', priority: 'HIGH' });
    const unprioritised = await seed({ family: 'BUG-SPOT', title: 'no priority' });
    await close(await seed({ family: 'BUG-SPOT', title: 'closed', priority: 'CRITICAL' }));

    const listed = ok(await backlogQuery(tmp.store, { view: 'list', filter: { repo: REPO } }));
    const spotlit = await spotlight(tmp.store, { repo: REPO }, 20);

    // The ordering contract, asserted against the SHIPPED spotlight op rather
    // than against a hand-written expectation of it.
    const prioritisedIds = (listed.items ?? []).filter((c) => c.priority !== undefined).map((c) => c.humanId);
    expect(prioritisedIds).toEqual(spotlit.map((i) => i.humanId));
    expect(prioritisedIds.length).toBe(4);

    // ...and the item set is list-items', not spotlight's: an unprioritised
    // item is ranked last, never hidden (§7.1 "a read never silently narrows").
    expect(ids(listed.items)).toContain(unprioritised);
    expect(ids(listed.items)[4]).toBe(unprioritised);
    // The closed item is out because the default status selector is "open".
    expect(listed.items).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// §2.4 / AC-18 / AC-19 — projection.
// ---------------------------------------------------------------------------

describe('§2.4 projection', () => {
  it('the default card is exactly the five terse fields — no body, ever (AC-18)', async () => {
    await seed({ family: 'BUG-PROJ', title: 'projected', body: 'X'.repeat(5000), priority: 'HIGH' });
    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO } }));
    const card = (data.items ?? [])[0] as IBacklogCard;
    expect(Object.keys(card).sort()).toEqual(['humanId', 'kind', 'priority', 'status', 'title']);
    expect(JSON.stringify(data)).not.toContain('XXXXX');
  });

  it('fields are additive and opt-in — body/citations/rollup only when named', async () => {
    const parent = await seed({ family: 'EPIC-PROJ', title: 'parent', priority: 'HIGH' });
    await splitItemNode(tmp.store, REPO, parent, [{ family: 'TASK-PROJ', title: 'child', body: 'c', repo: REPO }]);

    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, kind: 'EPIC' }, fields: ['body', 'citations', 'rollup'] }));
    const card = (data.items ?? [])[0] as IBacklogCard;
    expect(card.body).toContain('seeded body');
    expect(card.citations).toEqual([]);
    expect(card.rollup).toEqual({ childrenTotal: 1, childrenClosed: 0, childrenOpen: expect.any(Array), selfVerified: false });
  });

  it('an unknown field is a validation error naming it, never a silent omission (AC-19)', async () => {
    const env = await backlogQuery(tmp.store, { fields: ['humanId', 'nope'] as never });
    expect(isOutcomeError(env) && env.error.code).toBe('validation');
    expect(isOutcomeError(env) && env.error.message).toContain('nope');
    expect(exitCodeForEnvelope(env)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §7 / AC-23 — never accept-and-ignore an input key.
// ---------------------------------------------------------------------------

describe('§7 input contract', () => {
  it('a top-level parameter nested inside --filter is a targeted invalid_argument naming it (AC-23)', async () => {
    const env = await backlogQuery(tmp.store, { filter: { view: 'list' } as never });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
    expect(isOutcomeError(env) && env.error.message).toContain('"view"');
    expect(exitCodeForEnvelope(env)).toBe(2);
  });

  it('an unknown filter key is a validation error naming it (AC-23)', async () => {
    const env = await backlogQuery(tmp.store, { filter: { repoo: 'adhd' } as never });
    expect(isOutcomeError(env) && env.error.code).toBe('validation');
    expect(isOutcomeError(env) && env.error.message).toContain('repoo');
  });

  it('an unknown top-level key is rejected, and a backlog_get key gets a pointer to the right tool', async () => {
    const unknown = await backlogQuery(tmp.store, { nope: 1 } as never);
    expect(isOutcomeError(unknown) && unknown.error.code).toBe('validation');

    const getKey = await backlogQuery(tmp.store, { humanId: 'BUG-1' } as never);
    expect(isOutcomeError(getKey) && getKey.error.code).toBe('invalid_argument');
    expect(isOutcomeError(getKey) && getKey.error.message).toContain('backlog_get');
  });

  it('an unknown view / sort / groupBy axis is invalid_argument, never a silent fallback', async () => {
    for (const input of [{ view: 'spotlight' }, { sort: 'magic' }, { view: 'grouped', groupBy: 'colour' }]) {
      const env = await backlogQuery(tmp.store, input as never);
      expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
    }
  });

  it('a key that has no meaning for the requested view is rejected rather than dropped', async () => {
    const grouped = await backlogQuery(tmp.store, { view: 'list', groupBy: 'kind' });
    expect(isOutcomeError(grouped) && grouped.error.code).toBe('invalid_argument');
    expect(isOutcomeError(grouped) && grouped.error.message).toContain('groupBy');

    // view:"summary" delegates to computeStats, which takes repo/projectPath/
    // dateRange only — accepting `kind` would look scoped and not be.
    const scoped = await backlogQuery(tmp.store, { view: 'summary', filter: { kind: 'BUG' } });
    expect(isOutcomeError(scoped) && scoped.error.code).toBe('invalid_argument');
    expect(isOutcomeError(scoped) && scoped.error.message).toContain('"kind"');
  });
});

// ---------------------------------------------------------------------------
// AC-12 — the semantic channel degrades loudly.
// ---------------------------------------------------------------------------

describe('AC-12 semantic degrade', () => {
  it('semantic / anchor / view:similar / sort:relevance / _score all return rag_not_configured', async () => {
    const cases: Array<Record<string, unknown>> = [
      { filter: { semantic: 'sign-in button unresponsive' } },
      { filter: { anchor: 'BUG-QV2-001' } },
      { view: 'similar', filter: { semantic: 'x' } },
      { sort: 'relevance' },
      { fields: ['_score'] },
      { fields: ['_vector'] },
    ];
    for (const input of cases) {
      const env = await backlogQuery(tmp.store, input as never);
      expect(isOutcomeError(env) && env.error.code).toBe('rag_not_configured');
    }
  });

  it('grep and dimensional queries still work while the semantic channel is unavailable', async () => {
    await seed({ family: 'BUG-FTS', title: 'sign in button unresponsive', priority: 'HIGH' });
    await seed({ family: 'BUG-FTS', title: 'totally unrelated', priority: 'HIGH' });
    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, grep: 'unresponsive' } }));
    expect(data.items).toHaveLength(1);
    expect((data.items ?? [])[0]?.title).toContain('unresponsive');
  });
});

// ---------------------------------------------------------------------------
// §2.2 — the views that absorb a shipped v1 command keep its answer (AC-5).
// ---------------------------------------------------------------------------

describe('§2.2 views', () => {
  it('view:"order" returns topo-order\'s order plus wave numbers, and reports a real cycle', async () => {
    const a = await seed({ family: 'BUG-ORD', title: 'a' });
    const b = await seed({ family: 'BUG-ORD', title: 'b' });
    const c = await seed({ family: 'BUG-ORD', title: 'c' });
    const d = await seed({ family: 'BUG-ORD', title: 'independent' });
    await addDependencyNode(tmp.store, REPO, b, a);
    await addDependencyNode(tmp.store, REPO, c, b);

    const data = ok(await backlogQuery(tmp.store, { view: 'order', filter: { repo: REPO } }));
    const order = data.order;
    if (!order || !order.ok) throw new Error('expected an acyclic order');
    const shipped = await topoOrder(tmp.store, { repo: REPO });
    if (!shipped.ok) throw new Error('expected the shipped op to agree');
    expect(order.order.map((o) => o.humanId)).toEqual(shipped.order);

    const waveOf = new Map(order.order.map((o) => [o.humanId, o.wave]));
    expect(waveOf.get(a)).toBe(0);
    expect(waveOf.get(b)).toBe(1);
    expect(waveOf.get(c)).toBe(2);
    expect(waveOf.get(d)).toBe(0);

    await addDependencyNode(tmp.store, REPO, a, c); // close the loop
    const cyclic = ok(await backlogQuery(tmp.store, { view: 'order', filter: { repo: REPO } }));
    expect(cyclic.order?.ok).toBe(false);
    expect(cyclic.order?.ok === false && new Set(cyclic.order.cycle)).toEqual(new Set([a, b, c]));
  });

  it('view:"stale" returns exactly what stale-claims returns today (AC-5)', async () => {
    const claimed = await seed({ family: 'BUG-STALE', title: 'claimed' });
    await seed({ family: 'BUG-STALE', title: 'unclaimed' });
    await claim(claimed, 'agent-a');

    const now = ok(await backlogQuery(tmp.store, { view: 'stale', filter: { repo: REPO }, staleAfterMinutes: 0 }));
    expect((now.stale ?? []).map((s) => s.humanId)).toEqual((await staleClaims(tmp.store, 0, { repo: REPO })).map((i) => i.humanId));
    expect((now.stale ?? [])[0]?.claimedBy).toBe('agent-a');

    const withinLease = ok(await backlogQuery(tmp.store, { view: 'stale', filter: { repo: REPO } }));
    expect(withinLease.stale).toEqual([]);
  });

  it('view:"ready" is non-terminal, unclaimed and unblocked — and nothing else', async () => {
    const blocker = await seed({ family: 'BUG-READY', title: 'blocker' });
    const blocked = await seed({ family: 'BUG-READY', title: 'blocked' });
    const claimed = await seed({ family: 'BUG-READY', title: 'claimed' });
    const free = await seed({ family: 'BUG-READY', title: 'free' });
    await addDependencyNode(tmp.store, REPO, blocked, blocker);
    await claim(claimed, 'agent-b');

    const data = ok(await backlogQuery(tmp.store, { view: 'ready', filter: { repo: REPO } }));
    expect(new Set(ids(data.items))).toEqual(new Set([blocker, free]));

    await close(blocker);
    const after = ok(await backlogQuery(tmp.store, { view: 'ready', filter: { repo: REPO } }));
    expect(new Set(ids(after.items))).toEqual(new Set([blocked, free]));
  });

  it('view:"graph" surfaces the real dependency edge', async () => {
    const a = await seed({ family: 'BUG-GRAPH', title: 'a' });
    const b = await seed({ family: 'BUG-GRAPH', title: 'b' });
    await addDependencyNode(tmp.store, REPO, b, a);
    const data = ok(await backlogQuery(tmp.store, { view: 'graph', filter: { repo: REPO } }));
    expect(data.graph?.edges).toContainEqual({ from: b, to: a, rel: 'DEPENDS_ON' });
  });
});

// ---------------------------------------------------------------------------
// FEAT-007 — view:"grouped".
// ---------------------------------------------------------------------------

describe('FEAT-007 view:"grouped"', () => {
  it('buckets are counts-only by default and carry items only when fields names them', async () => {
    await seed({ family: 'BUG-GRP', title: 'bug one' });
    await seed({ family: 'BUG-GRP', title: 'bug two' });
    await seed({ family: 'DEBT-GRP', title: 'debt one' });

    const counts = ok(await backlogQuery(tmp.store, { view: 'grouped', filter: { repo: REPO }, groupBy: 'kind' }));
    expect(counts.grouped?.buckets).toEqual([
      { key: 'BUG', count: 2 },
      { key: 'DEBT', count: 1 },
    ]);

    const withItems = ok(await backlogQuery(tmp.store, { view: 'grouped', filter: { repo: REPO }, groupBy: 'kind', fields: ['items'] }));
    expect(withItems.grouped?.buckets[0]?.items).toHaveLength(2);
  });

  it('the author axis canonicalises identity — two runs of one agent are ONE bucket (AC-14)', async () => {
    const first = await seed({ family: 'BUG-AUTH', title: 'run one' });
    const second = await seed({ family: 'BUG-AUTH', title: 'run two' });
    const other = await seed({ family: 'BUG-AUTH', title: 'someone else' });
    await setMeta(first, { author: 'researcher:a1' });
    await setMeta(second, { author: 'researcher:b2' });
    await setMeta(other, { author: 'reviewer:z9' });

    const data = ok(await backlogQuery(tmp.store, { view: 'grouped', filter: { repo: REPO }, groupBy: 'author' }));
    expect(data.grouped?.buckets).toEqual([
      { key: 'researcher', count: 2 },
      { key: 'reviewer', count: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// FEAT-013 — demand, and the dimensional filters (AC-13/AC-17/§5a.7).
// ---------------------------------------------------------------------------

describe('FEAT-013 demand + dimensional filters', () => {
  it('sort:"demand" ranks a re-filed item above a once-filed one, and the dupe counter DOMINATES priority (AC-17)', async () => {
    const refiled = await seed({ family: 'BUG-DEMAND', title: 're-filed five times', priority: 'LOW' });
    const once = await seed({ family: 'BUG-DEMAND', title: 'filed once', priority: 'CRITICAL' });
    await setMeta(refiled, { dupeHits: 5 });
    await setMeta(once, { dupeHits: 0 });

    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO }, sort: 'demand' }));
    // The LOW-priority item outranks the CRITICAL one purely on demand: if the
    // counter were an incidental tiebreak behind priority, this would invert.
    expect(ids(data.items)).toEqual([refiled, once]);

    const min = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, dupeHitsMin: 2 } }));
    expect(ids(min.items)).toEqual([refiled]);
  });

  it('author/reporter filters exclude items missing the field (AC-13)', async () => {
    const mine = await seed({ family: 'BUG-DIM', title: 'mine' });
    await seed({ family: 'BUG-DIM', title: 'unattributed' });
    await setMeta(mine, { author: 'zed:run-1', reporter: 'zed:run-1' });

    expect(ids(ok(await backlogQuery(tmp.store, { filter: { repo: REPO, author: 'zed' } })).items)).toEqual([mine]);
    expect(ids(ok(await backlogQuery(tmp.store, { filter: { repo: REPO, reporter: 'zed' } })).items)).toEqual([mine]);
  });

  it('§5a.7 acceptance-criteria and citation presence are queryable filters', async () => {
    const withCriteria = await seed({ family: 'BUG-CRIT', title: 'has criteria', body: 'intro\n\n## Acceptance\n- it works' });
    const without = await seed({ family: 'BUG-CRIT', title: 'no criteria', body: 'just prose' });

    expect(ids(ok(await backlogQuery(tmp.store, { filter: { repo: REPO, hasAcceptanceCriteria: true } })).items)).toEqual([withCriteria]);
    expect(ids(ok(await backlogQuery(tmp.store, { filter: { repo: REPO, missingAcceptanceCriteria: true } })).items)).toEqual([without]);

    const cited = await seed({ family: 'BUG-CITE', title: 'cited' });
    await close(cited); // the terminal transition attaches the citation
    const missing = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, status: 'all', missingCitation: true } }));
    expect(ids(missing.items)).not.toContain(cited);
    expect(ids(missing.items)).toContain(without);
  });
});

// ---------------------------------------------------------------------------
// FEAT-010 — view:"summary".
// ---------------------------------------------------------------------------

describe('FEAT-010 view:"summary"', () => {
  it('reports open/closed counts, the REQUIRED coverage block, and bucketed transitions inside the window', async () => {
    const closed = await seed({ family: 'BUG-SUM', title: 'closed', priority: 'HIGH' });
    await seed({ family: 'BUG-SUM', title: 'open', priority: 'LOW' });
    await close(closed);

    const data = ok(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO } }));
    const summary = data.summary;
    expect(summary?.total).toBe(2);
    expect(summary?.open).toBe(1);
    expect(summary?.closed).toBe(1);
    expect(summary?.coverage.itemsTotal).toBe(2);
    expect(summary?.coverage.itemsWithHistory).toBeGreaterThanOrEqual(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(summary?.transitionsByBucket).toContainEqual({ bucket: today, count: 1 });
  });

  it('a window that excludes the transition excludes its bucket — the bound is honoured, not decorative (AC-15)', async () => {
    const closed = await seed({ family: 'BUG-WIN', title: 'closed' });
    await close(closed);
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const data = ok(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, dateRange: { updated: { since: future } } } }));
    expect(data.summary?.transitionsByBucket).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FEAT-015 — view:"plan", the resume surface.
// ---------------------------------------------------------------------------

describe('FEAT-015 view:"plan"', () => {
  const PLAN = 'plan-qv2';

  async function seedPlan(): Promise<{ blocker: string; blocked: string; mine: string; done: string }> {
    const blocker = await seed({ family: 'TASK-PLAN', title: 'blocker', plan: PLAN, priority: 'HIGH' });
    const blocked = await seed({ family: 'TASK-PLAN', title: 'blocked', plan: PLAN, priority: 'HIGH' });
    const mine = await seed({ family: 'TASK-PLAN', title: 'mine', plan: PLAN, priority: 'MEDIUM' });
    const done = await seed({ family: 'TASK-PLAN', title: 'done', plan: PLAN });
    await addDependencyNode(tmp.store, REPO, blocked, blocker);
    await claim(mine, 'agent-me');
    await close(done);
    return { blocker, blocked, mine, done };
  }

  it('one call answers "where was I": rollup, ready, blocked-with-reason, needsHuman, myClaims and an asOf token (AC-16)', async () => {
    const { blocker, blocked, mine, done } = await seedPlan();

    const data = ok(await backlogQuery(tmp.store, { view: 'plan', filter: { plan: PLAN, repo: REPO, claimedBy: 'agent-me' } }));
    const plan = data.plan;
    if (!plan) throw new Error('expected a plan payload');

    expect(plan.rollup.childrenTotal).toBe(4);
    expect(plan.rollup.childrenClosed).toBe(1);
    expect(new Set(plan.rollup.childrenOpen)).toEqual(new Set([blocker, blocked, mine]));
    expect(ids(plan.ready)).toEqual([blocker]);
    expect(plan.blocked).toEqual([{ item: expect.objectContaining({ humanId: blocked }), blockedBy: [blocker] }]);
    expect(ids(plan.myClaims)).toEqual([mine]);
    expect(ids(plan.needsHuman)).toEqual([blocker]); // `mine` is claimed, `blocked` has a blocker
    expect(plan.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ids(plan.ready)).not.toContain(done);

    // §5a.8 planReadiness ships with the plan view, shape pinned.
    expect(data.readiness).toEqual({
      planSlug: PLAN,
      totalCount: 4,
      doneCount: 1,
      readyCount: 1,
      blockedCount: 1,
      hasCycle: false,
      percentComplete: 25,
      nextRecommended: blocker,
    });
  });

  it('the asOf token is real: passing it back SHRINKS the delta (AC-16)', async () => {
    const { blocker } = await seedPlan();

    const first = ok(await backlogQuery(tmp.store, { view: 'plan', filter: { plan: PLAN, repo: REPO } }));
    const asOf = first.plan?.asOf as string;
    const deltaBefore = (first.plan?.delta ?? []).length;

    await transitionStatusNode(tmp.store, REPO, blocker, 'IN_PROGRESS', { by: BY });

    const full = ok(await backlogQuery(tmp.store, { view: 'plan', filter: { plan: PLAN, repo: REPO } }));
    expect((full.plan?.delta ?? []).length).toBeGreaterThan(deltaBefore); // the new event is in the unbounded history

    const resumed = ok(await backlogQuery(tmp.store, { view: 'plan', filter: { plan: PLAN, repo: REPO, dateRange: { updated: { since: asOf } } } }));
    expect((resumed.plan?.delta ?? []).length).toBeLessThan((full.plan?.delta ?? []).length);
    expect((resumed.plan?.delta ?? []).every((e) => e.at > asOf)).toBe(true);
  });

  it('§5a.8 criticalPath returns the weighted longest DEPENDS_ON chain within the plan', async () => {
    const a = await seed({ family: 'TASK-CP', title: 'a', plan: 'plan-cp' });
    const b = await seed({ family: 'TASK-CP', title: 'b', plan: 'plan-cp' });
    const c = await seed({ family: 'TASK-CP', title: 'c', plan: 'plan-cp' });
    const d = await seed({ family: 'TASK-CP', title: 'independent', plan: 'plan-cp' });
    await addDependencyNode(tmp.store, REPO, b, a);
    await addDependencyNode(tmp.store, REPO, c, b);
    void d;

    const data = ok(await backlogQuery(tmp.store, { view: 'plan', filter: { plan: 'plan-cp', repo: REPO }, weightFn: 'count' }));
    expect(data.criticalPath).toEqual({ plan: 'plan-cp', criticalChain: [a, b, c], length: 3, endItem: c });
  });

  it('view:"plan" without a plan slug is invalid_argument, not an empty answer', async () => {
    const env = await backlogQuery(tmp.store, { view: 'plan', filter: { repo: REPO } });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });
});

// ---------------------------------------------------------------------------
// FEAT-005 Stage 3 — view:"overlap".
// ---------------------------------------------------------------------------

describe('FEAT-005 view:"overlap"', () => {
  it('the file axis and the project axis produce DIFFERENT pairwise results (AC-28)', async () => {
    const a = await seed({ family: 'TASK-OV', title: 'a' });
    const b = await seed({ family: 'TASK-OV', title: 'b' });
    const c = await seed({ family: 'TASK-OV', title: 'c' });
    await setMeta(a, { files: ['src/one.ts', 'src/shared.ts'], project: 'alpha' });
    await setMeta(b, { files: ['src/shared.ts'], project: 'beta' });
    await setMeta(c, { files: ['src/three.ts'], project: 'alpha' });

    const byFile = ok(await backlogQuery(tmp.store, { view: 'overlap', filter: { repo: REPO }, humanIds: [a, b, c] }));
    expect(byFile.overlap).toEqual({ axis: 'file', pairs: [{ a, b, shared: ['src/shared.ts'] }] });

    const byProject = ok(await backlogQuery(tmp.store, { view: 'overlap', filter: { repo: REPO }, humanIds: [a, b, c], overlapBy: 'project' }));
    expect(byProject.overlap).toEqual({ axis: 'project', pairs: [{ a, b: c, shared: ['alpha'] }] });
  });

  it('an id that cannot be compared is an error, never a silent "no collision"', async () => {
    const a = await seed({ family: 'TASK-OVX', title: 'a' });
    const env = await backlogQuery(tmp.store, { view: 'overlap', filter: { repo: REPO }, humanIds: [a, 'TASK-NOPE-999'] });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
    expect(isOutcomeError(env) && env.error.message).toContain('TASK-NOPE-999');
  });
});

// ---------------------------------------------------------------------------
// §2.1b — the natural-language form.
// ---------------------------------------------------------------------------

describe('§2.1b natural-language query', () => {
  it('sends the WHOLE string to the matcher, stays unscoped, and reports extraction as boosts (AC-27)', async () => {
    await seed({ family: 'BUG-NL', title: 'apigen batch mount is broken', repo: 'someone/apigen' });
    const crossRepo = await seed({ family: 'BUG-NL', title: 'apigen batch mount is broken here too', repo: REPO });

    const data = ok(await backlogQuery(tmp.store, { text: 'apigen batch' }));
    expect(data.query?.semantic).toBe('apigen batch');
    // Extraction NEVER narrows: "apigen" is a known repo, and the item in the
    // OTHER repo must still rank (cross-repo recall is the contract).
    expect(data.query?.filter.repo).toBeUndefined();
    expect(data.query?.boosts.some((b) => b.term === 'apigen' && b.applied === 'boost')).toBe(true);
    expect(ids(data.items)).toContain(crossRepo);
    expect(data.items).toHaveLength(2);

    // ...and an explicit flag DOES scope it.
    const scoped = ok(await backlogQuery(tmp.store, { text: 'apigen batch', filter: { repo: REPO } }));
    expect(ids(scoped.items)).toEqual([crossRepo]);
  });

  it('a time expression compiles into filter.dateRange and is surfaced as an applied filter', async () => {
    await seed({ family: 'BUG-NLT', title: 'recent work' });
    const data = ok(await backlogQuery(tmp.store, { text: 'recent work since yesterday' }));
    expect(data.query?.filter.dateRange?.updated?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.query?.extracted.some((e) => e.type === 'time' && e.applied === 'filter')).toBe(true);
    expect(data.items?.length).toBeGreaterThanOrEqual(1);
  });

  it('text combined with filter.grep is rejected — one of the two keyword predicates would be dropped', async () => {
    const env = await backlogQuery(tmp.store, { text: 'anything', filter: { grep: 'else' } });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });
});

// ---------------------------------------------------------------------------
// §7.1 / AC-7 / AC-24 — repo resolution never silently narrows.
// ---------------------------------------------------------------------------

describe('§7.1 repo resolution', () => {
  it('a bare repo name includes items filed under its alias spelling (AC-7)', async () => {
    const bare = await seed({ family: 'BUG-ALIAS', title: 'filed bare', repo: 'adhd' });
    const qualified = await seed({ family: 'BUG-ALIAS', title: 'filed qualified', repo: 'PseudoSky/adhd' });
    const data = ok(await backlogQuery(tmp.store, { filter: { repo: 'adhd' } }));
    expect(new Set(ids(data.items))).toEqual(new Set([bare, qualified]));
  });

  it('a bare name matching two DIFFERENT repos returns both plus a warning naming the ambiguity (AC-24)', async () => {
    const alice = await seed({ family: 'BUG-AMB', title: 'alice', repo: 'alice/tool' });
    const bob = await seed({ family: 'BUG-AMB', title: 'bob', repo: 'bob/tool' });
    const env = await backlogQuery(tmp.store, { filter: { repo: 'tool' } });
    const data = ok(env);
    expect(new Set(ids(data.items))).toEqual(new Set([alice, bob]));
    expect(isOutcomeOk(env) && env.warnings?.join(' ')).toContain('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// §7.3 — format:"table".
// ---------------------------------------------------------------------------

describe('§7.3 format:"table"', () => {
  it('renders grouped buckets for humans WITHOUT replacing the structured payload', async () => {
    await seed({ family: 'BUG-TBL', title: 'one' });
    await seed({ family: 'DEBT-TBL', title: 'two' });
    const data = ok(await backlogQuery(tmp.store, { view: 'grouped', filter: { repo: REPO }, groupBy: 'kind', format: 'table' }));
    expect(data.table).toContain('KIND');
    expect(data.table).toContain('BUG');
    expect(data.grouped?.buckets).toHaveLength(2);
  });

  it('table on a JSON-only view is an error, not an ignored flag', async () => {
    const env = await backlogQuery(tmp.store, { view: 'list', format: 'table' });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });
});

// ---------------------------------------------------------------------------
// §7.2 — an empty list is a SUCCESS, not a not-found.
// ---------------------------------------------------------------------------

describe('§7.2 envelope', () => {
  it('an empty result is ok:true with an empty array and exit code 0', async () => {
    const env = await backlogQuery(tmp.store, { filter: { repo: 'nothing/here' } });
    expect(isOutcomeOk(env)).toBe(true);
    expect(ok(env).items).toEqual([]);
    expect(exitCodeForEnvelope(env)).toBe(0);
    expect(isOutcomeOk(env) && env.meta).toEqual({ total: 0, returned: 0 });
  });

  it('attachToPlan-filed members are reachable by filter.plan (the plan axis is a filter, not a type)', async () => {
    const id = await seed({ family: 'TASK-ATT', title: 'attached' });
    await attachToPlanNode(tmp.store, REPO, id, 'plan-attached');
    expect(ids(ok(await backlogQuery(tmp.store, { filter: { repo: REPO, plan: 'plan-attached' } })).items)).toEqual([id]);
  });
});
