/**
 * stats-surface.spec.ts — the ONE coherent stats/query surface behind three
 * work orders, each driven through its REAL seam against a REAL store (and a
 * REAL spawned built server for the HTTP half):
 *
 * - FEAT-009 (WO-1): `citationCount` on query cards + the summary citation
 *   dimension (`citationsTotal` / `citationCoverage` /
 *   `byFamilyCitationCoverage`) — a citation heatmap needs ZERO per-item
 *   gets / `_batch` fan-out.
 * - FEAT-BACKLOG-010 (WO-2): per-item `closedAt` (reconstructed from the
 *   persisted transition audit log) + the historical `closedByBucket` /
 *   `openedByBucket` throughput series.
 * - FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001 (WO-3): summary honours
 *   `family`/`status`/`kind`/`priority` scope (no silent discard — the whole
 *   point of the work order) and takes an explicit `window` param.
 *
 * Every store-level test opens a real temp turso-backed `GraphBacklogStore`
 * (`openTmpStore`), files real items with the real `createItemNode` (citations
 * included at create time), closes them with the real
 * `transitionStatusNode` (through the §5a.2 evidence gate), and calls the real
 * `backlogQuery`/`backlogGet` entrypoints. Nothing is mocked — AGENTS.md §7's
 * "verify the consumer outcome through REAL components" is the whole bar.
 *
 * The final describe boots the REAL BUILT bin (`node dist/index.js serve
 * --transport http`) as a genuine child process against an isolated store
 * (`ADHD_BACKLOG_DATABASE_PATH` → tmp), and POSTs the exact HTTP shapes a
 * browser/web consumer uses (`{data:{input:…}}`), asserting the new fields and
 * series appear on the wire. `nx test backlog` depends on `build`, so `dist/`
 * is guaranteed present (same contract `serve.spec.ts` already relies on).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { openTmpStore, type TmpStore } from './test/helpers/tmp-store.js';
import { createItemNode } from './store/crud.js';
import { transitionStatusNode } from './store/lifecycle.js';
import { backlogQuery, type IBacklogQueryResult } from './v2/query.js';
import { backlogGet } from './v2/get.js';
import {
  isOutcomeOk,
  type BacklogStatus,
  type IOutcomeEnvelope,
  type Priority,
} from './model.js';

const REPO = 'PseudoSky/stats-surface';
const BY = 'stats-surface-spec';
const CIT = { file: 'entrypoint/backlog/src/stats-surface.spec.ts', lines: '1-2', context: 'stats-surface-spec' };

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('stats-surface-spec');
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
  priority?: Priority;
  citations?: typeof CIT[];
}

async function seed(opts: ISeedOptions = {}): Promise<string> {
  const input: Parameters<typeof createItemNode>[1] = {
    family: opts.family ?? 'BUG-SS',
    title: opts.title ?? 'seeded',
    body: 'body',
    repo: opts.repo ?? REPO,
    force: true,
  };
  if (opts.priority) input.priority = opts.priority;
  if (opts.citations) input.citations = opts.citations;
  const result = await createItemNode(tmp.store, input);
  if (!result.created) throw new Error(`fixture: create was suppressed for ${input.title}`);
  return result.item.humanId;
}

/** Closes an item through the REAL lifecycle gate (a terminal transition without a citation is refused — model.ts:75). */
async function close(humanId: string, repo = REPO, status: BacklogStatus = 'RESOLVED'): Promise<void> {
  await transitionStatusNode(tmp.store, repo, humanId, status, { by: BY, citations: [CIT] });
}

function okQuery(env: IOutcomeEnvelope<IBacklogQueryResult>): IBacklogQueryResult {
  if (!isOutcomeOk(env)) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

// ---------------------------------------------------------------------------
// FEAT-009 (WO-1) — citationCount + summary citation dimension.
// ---------------------------------------------------------------------------

describe('FEAT-009 — citationCount on cards + the summary citation dimension', () => {
  it('query({view:"list", fields:["citationCount"]}) returns per-item counts for the WHOLE population — no per-item gets, no batch', async () => {
    const cited = await seed({ family: 'BUG-CIT', title: 'one citation', citations: [CIT] });
    const uncited = await seed({ family: 'BUG-CIT', title: 'zero citations' });
    const twoCits = await seed({ family: 'BUG-CIT2', title: 'two citations', citations: [CIT, { ...CIT, file: 'second.ts' }] });

    const data = okQuery(await backlogQuery(tmp.store, { view: 'list', filter: { repo: REPO, status: 'all' }, fields: ['citationCount'] }));
    const byId = new Map((data.items ?? []).map((c) => [c.humanId, c.citationCount]));
    expect(byId.get(cited)).toBe(1);
    expect(byId.get(uncited)).toBe(0);
    expect(byId.get(twoCits)).toBe(2);
    // Every card carries the field — the whole point: a heatmap needs no
    // `_batch/action` fan-out over the population.
    for (const card of data.items ?? []) expect(typeof card.citationCount).toBe('number');
  });

  it('backlog_get honours fields:["citationCount"] the same way (one projection vocabulary, §7.3)', async () => {
    const cited = await seed({ family: 'BUG-CIT', title: 'cited', citations: [CIT, CIT] });
    const env = await backlogGet(tmp.store, { humanId: cited, repo: REPO, fields: ['citationCount'] });
    expect(isOutcomeOk(env)).toBe(true);
    if (!isOutcomeOk(env)) throw new Error('unreachable');
    expect(env.data.citationCount).toBe(2);
  });

  it('view:"summary" reports citation coverage for the scoped population (citationsTotal / citationCoverage / byFamilyCitationCoverage)', async () => {
    // BUG-CIT: 2 cited + 1 uncited → 66.7% coverage; BUG-CIT2: 0 cited → 0%.
    await seed({ family: 'BUG-CIT', title: 'a', citations: [CIT] });
    await seed({ family: 'BUG-CIT', title: 'b', citations: [CIT] });
    await seed({ family: 'BUG-CIT', title: 'c' });
    await seed({ family: 'BUG-CIT2', title: 'd' });

    const data = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, status: 'all' } }));
    const summary = data.summary;
    if (!summary) throw new Error('expected a summary payload');
    expect(summary.citationsTotal).toBe(2);
    expect(summary.citationCoverage).toBe(50); // 2 of 4 items carry ≥1 citation
    expect(summary.byFamilyCitationCoverage['BUG-CIT']).toBe(round1((2 / 3) * 100));
    expect(summary.byFamilyCitationCoverage['BUG-CIT2']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FEAT-BACKLOG-010 (WO-2) — closedAt + the historical throughput series.
// ---------------------------------------------------------------------------

describe('FEAT-BACKLOG-010 — closedAt + closedByBucket/openedByBucket', () => {
  it('fields:["closedAt"] is populated for terminal items and absent for open ones', async () => {
    const closed = await seed({ family: 'BUG-CL', title: 'will close' });
    const open = await seed({ family: 'BUG-CL', title: 'stays open' });
    await close(closed);

    const data = okQuery(await backlogQuery(tmp.store, { view: 'list', filter: { repo: REPO, status: 'all' }, fields: ['closedAt', 'citationCount'] }));
    const byId = new Map((data.items ?? []).map((c) => [c.humanId, c]));
    const closedCard = byId.get(closed);
    const openCard = byId.get(open);
    expect(closedCard).toBeDefined();
    expect(openCard).toBeDefined();
    // Reconstructed from the REAL persisted transition event — an ISO
    // timestamp, not a guess.
    expect(closedCard?.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(openCard?.closedAt).toBeUndefined();
  });

  it('view:"summary" returns the historical weekly closed/opened series; sum(closedByBucket) == items ever closed, sum(openedByBucket) == population', async () => {
    const c1 = await seed({ family: 'BUG-HIST', title: 'c1' });
    const c2 = await seed({ family: 'BUG-HIST', title: 'c2' });
    const o = await seed({ family: 'BUG-HIST', title: 'o' });
    await close(c1);
    await close(c2);

    const data = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, status: 'all' }, bucket: 'week' }));
    const summary = data.summary;
    if (!summary) throw new Error('expected a summary payload');

    // The series exists at all — the gap the work order named ("only the
    // current-window closedInWindow existed").
    expect(summary.closedByBucket?.length).toBeGreaterThanOrEqual(1);
    expect(summary.openedByBucket?.length).toBeGreaterThanOrEqual(1);

    const closedSum = (summary.closedByBucket ?? []).reduce((a, b) => a + b.count, 0);
    const openedSum = (summary.openedByBucket ?? []).reduce((a, b) => a + b.count, 0);
    // One "closed" event per item (first terminal transition) — never a
    // double-count on reopen.
    expect(closedSum).toBe(2);
    // openedByBucket reads createdAt directly → exact for EVERY item.
    expect(openedSum).toBe(3);

    // The same item counts exactly once in the closed series, and the series
    // is the historical complement to the windowed closedInWindow.
    expect(summary.closed).toBe(2);

    // The BARE query (no bucket, no window) is the "historical" case the
    // work order named: the series spans ALL history at the default day
    // grain, with the same sums — never clamped to the AC-15 30-day window.
    const bare = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, status: 'all' } }));
    expect((bare.summary?.closedByBucket ?? []).reduce((a, b) => a + b.count, 0)).toBe(2);
    expect((bare.summary?.openedByBucket ?? []).reduce((a, b) => a + b.count, 0)).toBe(3);
    void o;
  });

  it('an explicit window bounds the throughput series — the AC-15 negative control (a transition outside the window contributes nothing)', async () => {
    const closed = await seed({ family: 'BUG-WIN', title: 'closed' });
    await close(closed);
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const data = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, status: 'all' }, window: { since: future }, bucket: 'day' }));
    const summary = data.summary;
    if (!summary) throw new Error('expected a summary payload');
    expect(summary.closedByBucket).toEqual([]);
    expect(summary.openedByBucket).toEqual([]);
    expect(summary.closedInWindow).toBe(0);
    expect(summary.transitionsByBucket).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001 (WO-3) — summary scope +
// the explicit window param.
// ---------------------------------------------------------------------------

describe('FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001 — summary honours scope and takes a window', () => {
  async function seedMixed(): Promise<void> {
    await seed({ family: 'BUG-SCOPED', title: 'fam-a open', priority: 'HIGH' });
    await seed({ family: 'BUG-SCOPED', title: 'fam-a open 2', priority: 'LOW' });
    const aClosed = await seed({ family: 'BUG-SCOPED', title: 'fam-a closed', priority: 'HIGH' });
    await close(aClosed);
    await seed({ family: 'BUG-OTHER', title: 'fam-b open', priority: 'LOW' });
    const bClosed = await seed({ family: 'BUG-OTHER', title: 'fam-b closed', priority: 'LOW' });
    await close(bClosed);
  }

  it('filter:{family, status:"open"} ACTUALLY changes the numbers — the silent-discard bug is gone', async () => {
    await seedMixed();

    const unscoped = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, status: 'all' } }));
    expect(unscoped.summary?.total).toBe(5);

    // The negative control: scoping by family+status must produce DIFFERENT
    // numbers — before this work order, summary silently returned the
    // unscoped totals for any family/status filter.
    const scoped = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, family: 'BUG-SCOPED', status: 'open' } }));
    const s = scoped.summary;
    if (!s) throw new Error('expected a summary payload');
    expect(s.total).toBe(2); // the two open BUG-SCOPED items — not 5, not 3
    expect(s.closed).toBe(0);
    expect(s.byFamilyAllStatuses).toEqual({ 'BUG-SCOPED': 2 });
    expect(Object.keys(s.byStatus).every((k) => k === 'OPEN' || !['RESOLVED', 'FIXED'].includes(k))).toBe(true);

    const closedScoped = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, family: 'BUG-SCOPED', status: 'closed' } }));
    expect(closedScoped.summary?.total).toBe(1);
    expect(closedScoped.summary?.open).toBe(0);
    expect(closedScoped.summary?.closed).toBe(1);
  });

  it('an unsupported summary filter key is a typed error naming it — never a silent drop (WO-3: "or errors loudly")', async () => {
    const env = await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, plan: 'some-plan' } });
    expect(isOutcomeOk(env)).toBe(false);
    if (isOutcomeOk(env)) throw new Error('unreachable');
    expect(env.error.code).toBe('invalid_argument');
    expect(env.error.message).toContain('"plan"');
  });

  it('the explicit window param is honoured on summary (windowed totals over an arbitrary window)', async () => {
    const closed = await seed({ family: 'BUG-W', title: 'closed' });
    await close(closed);
    const sinceNow = new Date(Date.now() + 60 * 1000).toISOString();
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    // Window excludes everything → windowed numbers are zero.
    const empty = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, status: 'all' }, window: { since: sinceNow } }));
    expect(empty.summary?.closedInWindow).toBe(0);
    expect(empty.summary?.openedInWindow).toBe(0);

    // Window since yesterday includes the today-closed item.
    const covering = okQuery(await backlogQuery(tmp.store, { view: 'summary', filter: { repo: REPO, status: 'all' }, window: { since: past } }));
    expect(covering.summary?.closedInWindow).toBe(1);
    expect(covering.summary?.openedInWindow).toBe(1);
  });

  it('window is rejected on any non-summary view, and a malformed window fails loudly', async () => {
    const onList = await backlogQuery(tmp.store, { view: 'list', window: { since: '2026-01-01T00:00:00Z' } });
    expect(isOutcomeOk(onList)).toBe(false);
    if (isOutcomeOk(onList)) throw new Error('unreachable');
    expect(onList.error.code).toBe('invalid_argument');
    expect(onList.error.message).toContain('view:"list"');

    const badShape = await backlogQuery(tmp.store, { view: 'summary', window: { since: 12345 } as never });
    expect(isOutcomeOk(badShape)).toBe(false);
    if (isOutcomeOk(badShape)) throw new Error('unreachable');
    expect(badShape.error.message).toContain('window.since');
  });
});

// ---------------------------------------------------------------------------
// The REAL built API over HTTP — `node dist/index.js serve --transport http`,
// the exact shapes a browser consumer posts (`{data:{input:…}}`).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const HTTP_REPO = 'PseudoSky/stats-surface-http';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttpReady(port: number, path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
      await res.text().catch(() => undefined);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`built server never became ready on port ${port}: ${String(lastErr)}`);
}

describe('FEAT-009/FEAT-BACKLOG-010/WO-3 over the REAL built HTTP server (spawned dist, real fetch)', () => {
  let proc: ChildProcess | undefined;
  let port = 0;
  let storeDir = '';

  afterEach(async () => {
    if (proc && proc.exitCode === null) proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300)); // let the process reap
    proc = undefined;
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    storeDir = '';
  });

  async function start(): Promise<number> {
    port = await freePort();
    storeDir = mkdtempSync(join(tmpdir(), 'backlog-stats-http-'));
    proc = spawn(process.execPath, [DIST_INDEX, 'serve', '--transport', 'http', '--port', String(port), '--host', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(process.env as Record<string, string>), ADHD_BACKLOG_SCOPE: 'project', ADHD_BACKLOG_DATABASE_PATH: join(storeDir, 'backlog.db') },
    });
    let bootLog = '';
    proc.stderr?.on('data', (d) => (bootLog += String(d)));
    proc.stdout?.on('data', (d) => (bootLog += String(d)));
    await waitForHttpReady(port, '/_meta/openapi');
    return port;
  }

  function post(path: string, input: unknown): Promise<{ status: number; json: unknown }> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input } }),
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as unknown }));
  }

  it('a consumer POSTs the exact HTTP shapes and gets citationCount + closedAt + the scoped summary series back', async () => {
    await start();

    const created: string[] = [];
    for (const [family, title, citations] of [
      ['BUG-HTTP', 'cited-open', [{ file: 'a.ts' }]],
      ['BUG-HTTP', 'will-close', [{ file: 'b.ts' }, { file: 'c.ts' }]],
      ['BUG-HTTP', 'uncited-open', []],
    ] as const) {
      const r = await post('/backlog/create', {
        item: { family, title, body: 'x', repo: HTTP_REPO, citations },
        by: 'stats-surface-http:1',
        // These three are STATS fixtures, not dedupe fixtures. They share a
        // family and a one-character body by design, so once semantic dedupe
        // is switched on (`embedding.enabled`, which the spawned server reads
        // from the machine's own `@adhd/environment` config) the filing gate
        // legitimately intercepts the third as a near-duplicate of the first
        // and the suite fails on a feature working correctly. `file` is the
        // documented confirmed-re-file that says "yes, mint it anyway" — the
        // gate itself is proven by `rag-dedupe`'s own specs, which is where
        // that assertion belongs.
        duplicateAction: 'file',
      });
      expect(r.status).toBe(200);
      const env = r.json as { ok: boolean; data: { created: boolean; humanId: string } };
      expect(env.ok).toBe(true);
      expect(env.data.created).toBe(true);
      created.push(env.data.humanId);
    }
    expect(created).toHaveLength(3);

    // Close ONE item through the real transition gate over HTTP (update with
    // status + statusEvidence.citations satisfies the §5a.2 evidence rule —
    // DEBT-010: transition evidence is bundled under `statusEvidence`, not a
    // standalone top-level `citations` field).
    const closed = await post('/backlog/update', {
      humanId: created[1],
      repo: HTTP_REPO,
      by: 'stats-surface-http:2',
      status: 'RESOLVED',
      statusEvidence: { citations: [{ file: 'c.ts' }] },
    });
    expect((closed.json as { ok: boolean }).ok).toBe(true);

    // 1) WO-1: the population query carries citationCount on EVERY card —
    //    the heatmap needs no _batch fan-out.
    const list = await post('/backlog/query', {
      view: 'list',
      filter: { repo: HTTP_REPO, status: 'all' },
      fields: ['citationCount', 'closedAt'],
    });
    const listEnv = list.json as {
      ok: boolean;
      data: { items: Array<{ humanId: string; citationCount?: number; closedAt?: string }> };
    };
    expect(listEnv.ok).toBe(true);
    const byId = new Map(listEnv.data.items.map((c) => [c.humanId, c]));
    expect(byId.get(created[0])?.citationCount).toBe(1);
    // 'will-close' carries 2 create-time citations + the 1 inline citation the
    // RESOLVED transition attached through the evidence gate = 3.
    expect(byId.get(created[1])?.citationCount).toBe(3);
    expect(byId.get(created[2])?.citationCount).toBe(0);
    // WO-2: closedAt present exactly on the terminal item.
    expect(byId.get(created[1])?.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byId.get(created[0])?.closedAt).toBeUndefined();

    // 2) WO-2: the summary carries the historical closed series.
    const summary = await post('/backlog/query', { view: 'summary', filter: { repo: HTTP_REPO, status: 'all' }, bucket: 'week' });
    const sEnv = summary.json as { ok: boolean; data: { summary: { closedByBucket: Array<{ bucket: string; count: number }>; openedByBucket: Array<{ bucket: string; count: number }>; closedInWindow: number } } };
    expect(sEnv.ok).toBe(true);
    const s = sEnv.data.summary;
    expect(s.closedByBucket.reduce((a, b) => a + b.count, 0)).toBe(1);
    expect(s.openedByBucket.reduce((a, b) => a + b.count, 0)).toBe(3);

    // 3) WO-3: family scope CHANGES the numbers over HTTP (the negative
    //    control) and the window param is honoured on the wire.
    const scoped = await post('/backlog/query', { view: 'summary', filter: { repo: HTTP_REPO, family: 'BUG-HTTP', status: 'open' } });
    const scopedEnv = scoped.json as { ok: boolean; data: { summary: { total: number; open: number; closed: number } } };
    expect(scopedEnv.ok).toBe(true);
    expect(scopedEnv.data.summary.total).toBe(2); // the two open BUG-HTTP items only

    const windowed = await post('/backlog/query', { view: 'summary', filter: { repo: HTTP_REPO, status: 'all' }, window: { since: new Date(Date.now() + 60_000).toISOString() } });
    const wEnv = windowed.json as { ok: boolean; data: { summary: { closedInWindow: number; openedInWindow: number } } };
    expect(wEnv.ok).toBe(true);
    expect(wEnv.data.summary.closedInWindow).toBe(0);
    expect(wEnv.data.summary.openedInWindow).toBe(0);
  }, 60_000);
});

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
