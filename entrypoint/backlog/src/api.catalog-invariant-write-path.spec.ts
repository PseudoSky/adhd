/**
 * api.catalog-invariant-write-path.spec.ts — the write-path half of the
 * "guards must not take anything down" invariant.
 *
 * ## The defect this pins
 *
 * The status/priority catalog-invariant guard was wired into the write path:
 * `api.ts`'s `writeHandle` awaited `assertCatalogInvariants` on EVERY write
 * verb. That function THROWS on any catalog drift, so a store whose catalog
 * already had one bad row (a reserved-named terminal status missing its flag,
 * or one status value split across two case-variant rows) refused EVERY write
 * — every verb, for every caller — until someone repaired it by hand. The
 * refusal was not even targeted: an unrelated `upsertProject` was rejected
 * because some other status row was wrong. It is the same shape that caused
 * two total outages on the READ path before commit 7c941505 moved the read
 * abort off; the write path kept the identical defect.
 *
 * ## The posture after this change
 *
 * A catalog violation is PREVENTED at the write by the TARGETED case-variant
 * refusal in `mintOrResolveCatalogTx` (a caller-typed `Open` where `open` is
 * live is refused by `CaseVariantNameError`, naming both spellings, so a bad
 * write cannot CREATE the drift) and DETECTED LOUDLY by the `store-check` CLI
 * verb (non-zero, naming every offending row and its repair). It is never
 * allowed to take down reads OR unrelated writes. This is a NAMED check, not
 * a silent degrade and not a fallback.
 *
 * ## How the teeth work
 *
 *  1. REGRESSION — seed the exact drift into a real store, then drive an
 *     ordinary write through the REAL `api.ts` verb surface (a real
 *     `BacklogCtx`, a real `GraphBacklogStore`). Before the fix that write came
 *     back `{ok:false}` carrying `CatalogInvariantError`; it must now succeed.
 *  2. NO CONSULT — the guard module is wrapped in a delegating spy. On a store
 *     proven to violate the invariant, an ordinary write must leave the spy at
 *     zero calls. Reintroducing the blanket `assertCatalogInvariants` call in
 *     `writeHandle` drives the count to 1 and turns the test RED.
 *  3. STORE-CHECK — the real `runBacklogCli(['store-check'])` verb, driven
 *     in-process against the same drifted store, must exit NON-ZERO and print
 *     the guard's message naming the rows; after the NAMED repair runs, the
 *     same verb must go GREEN (exit 0). Falsifiable, not decorative.
 *  4. CASE-VARIANT REFUSAL — an ordinary `create` with a status whose case
 *     differs from a live row is still refused at the mint, so the guard's
 *     duplicate check can no longer be tripped by an ordinary write.
 *
 * The `.spec.ts` suffix is load-bearing: `vite.config.ts` includes only
 * `src/**\/*.spec.ts`, so this is picked up by `nx affected -t test`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  openGraphBacklogStore,
  type GraphBacklogStore,
} from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';
import { create, upsertProject, type BacklogCtx } from './api.js';
import { executeWriteTransaction, writeNodeTx } from './write/tx.js';
import { isOutcomeOk } from './envelope.js';
import { freshTmpDir } from './test/helpers/tmp-store.js';
import { runBacklogCli } from './cli.js';
import { inspectCatalogInvariants } from './store/catalog-invariant-guard.js';
import {
  planTerminalBackfill,
  applyTerminalBackfill,
} from './write/catalog-repair.js';
import {
  planCaseFragmentMerge,
  applyCaseFragmentMerge,
} from './write/catalog-merge.js';

/**
 * A delegating spy over the guard's `assertCatalogInvariants`. Vitest hoists
 * `vi.mock` above the imports, so the hoisted counter is the only way to
 * observe calls from inside the factory. The wrapper calls the REAL guard, so
 * `store-check`'s behavior is unchanged — only the call is observable.
 */
const guardSpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('./store/catalog-invariant-guard.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./store/catalog-invariant-guard.js')
  >();
  return {
    ...actual,
    assertCatalogInvariants: async (
      adapter: Parameters<typeof actual.assertCatalogInvariants>[0]
    ) => {
      guardSpy.calls += 1;
      return actual.assertCatalogInvariants(adapter);
    },
  };
});

const TIMEOUT = 30_000;

interface Harness {
  ctx: BacklogCtx;
  store: GraphBacklogStore;
  dir: string;
  dbPath: string;
}

/** Open a REAL store + REAL ctx — the exact shape `api.semantic-laziness.spec.ts` drives. */
async function openHarness(name: string): Promise<Harness> {
  const dir = freshTmpDir(name);
  const dbPath = join(dir, 'backlog.db');
  const store = await openGraphBacklogStore(dbPath);
  const env = buildBacklogEnv({ adhdRoot: dir });
  return { ctx: { store, env }, store, dir, dbPath };
}

/** Idempotent teardown: a test may have closed the adapter itself. */
async function closeHarness(h: Harness): Promise<void> {
  await h.store.adapter.close().catch(() => undefined);
  rmSync(h.dir, { recursive: true, force: true });
}

/** Mint a bare catalog row through the same `writeNodeTx` primitive every verb uses. */
async function mintCatalog(
  store: GraphBacklogStore,
  kind: 'status' | 'priority',
  name: string,
  metadata: Record<string, unknown> = {}
): Promise<{ rowid: number; uid: string }> {
  return executeWriteTransaction(store, (tx) =>
    writeNodeTx(tx, { kind, name, metadata })
  );
}

/** Seed the drift the guard exists to catch: a reserved terminal name with no flag. */
async function seedFlaglessReserved(
  store: GraphBacklogStore,
  name = 'closed'
): Promise<string> {
  const row = await mintCatalog(store, 'status', name, {});
  return row.uid;
}

describe('api.ts write path — a catalog-drifted store still accepts ordinary writes', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await openHarness('api-catalog-write-path');
    guardSpy.calls = 0;
  });

  afterEach(async () => {
    await closeHarness(h);
  });

  it(
    'REGRESSION: an ordinary write to a store with a drifted status catalog SUCCEEDS',
    async () => {
      // Seed the exact drift: a live reserved-named status with no terminal flag.
      await seedFlaglessReserved(h.store, 'closed');
      // Prove the drift is real (the inspector is the guard's own bounded read).
      expect(await inspectCatalogInvariants(h.store.adapter)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'unflagged-terminal', name: 'closed' }),
        ])
      );

      // The write is UNRELATED to the catalog — a project upsert. Before the
      // fix, `writeHandle` ran the blanket guard and this came back
      // `{ok:false}` carrying `CatalogInvariantError` (see the RED capture in
      // the task report). It must now commit.
      const proj = await upsertProject(h.ctx, { name: 'P', by: 't' });
      expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);

      // And a second, semantic-gated write verb takes the same path.
      const issue = await create(h.ctx, {
        project: 'P',
        title: 'still writable on a drifted store',
        body: 'the catalog drift must not block an issue write',
        by: 't',
      });
      expect(isOutcomeOk(issue), JSON.stringify(issue)).toBe(true);
      if (!isOutcomeOk(issue)) throw new Error('unreachable');
      expect(issue.data.uid).toBeTruthy();
    },
    TIMEOUT
  );

  it(
    'the write path NEVER consults assertCatalogInvariants — reintroducing the blanket call turns this RED',
    async () => {
      await seedFlaglessReserved(h.store, 'closed');
      // The store genuinely violates the invariant, so the spy's zero count
      // below is meaningful rather than vacuous.
      expect(await inspectCatalogInvariants(h.store.adapter)).not.toEqual([]);
      guardSpy.calls = 0;

      const proj = await upsertProject(h.ctx, { name: 'Q', by: 't' });
      expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);
      const issue = await create(h.ctx, {
        project: 'Q',
        title: 'no implicit guard consultation',
        body: 'b',
        by: 't',
      });
      expect(isOutcomeOk(issue), JSON.stringify(issue)).toBe(true);

      // If `writeHandle` were wired back to the guard, its delegating spy would
      // run (and throw on this drifted store), so this count would be ≥ 1.
      expect(guardSpy.calls).toBe(0);
    },
    TIMEOUT
  );

  it(
    'the case-variant refusal is unchanged: a create with a case-variant status is refused at the mint',
    async () => {
      await upsertProject(h.ctx, { name: 'R', by: 't' });
      const first = await create(h.ctx, {
        project: 'R',
        title: 'canonical',
        body: 'mints status open',
        by: 't',
      });
      expect(isOutcomeOk(first), JSON.stringify(first)).toBe(true);

      const second = await create(h.ctx, {
        project: 'R',
        title: 'non-canonical',
        body: 'must be refused, not minted as a second status row',
        status: 'Open',
        by: 't',
      });
      expect(isOutcomeOk(second)).toBe(false);
      if (isOutcomeOk(second)) throw new Error('unreachable');
      expect(second.error.message).toContain('"Open"');
      expect(second.error.message).toContain('"open"');
    },
    TIMEOUT
  );
});

describe('store-check — the NAMED detector stays loud and falsifiable', () => {
  let h: Harness;
  let prevDbPath: string | undefined;
  let prevExit: typeof process.exitCode;

  beforeEach(async () => {
    h = await openHarness('api-catalog-store-check');
    guardSpy.calls = 0;
    prevDbPath = process.env['ADHD_BACKLOG_DATABASE_PATH'];
    prevExit = process.exitCode;
  });

  afterEach(async () => {
    if (prevDbPath === undefined) delete process.env['ADHD_BACKLOG_DATABASE_PATH'];
    else process.env['ADHD_BACKLOG_DATABASE_PATH'] = prevDbPath;
    process.exitCode = prevExit;
    vi.restoreAllMocks();
    await closeHarness(h);
  });

  it(
    'exits NON-ZERO naming every offending row and the repair, then GREEN after the named repair',
    async () => {
      // Seed BOTH violations into the same store.
      const closedUid = await seedFlaglessReserved(h.store, 'closed');
      const upper = await mintCatalog(h.store, 'priority', 'HIGH', { rank: 1 });
      const lower = await mintCatalog(h.store, 'priority', 'high', { rank: 2 });
      // Release the file before the verb opens it.
      await h.store.adapter.close();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const errText = (): string =>
        errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      const logText = (): string =>
        logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

      // Drive the REAL verb in-process, pointed at the throwaway store via the
      // documented override. `adhdRoot` keeps every other root under tmp.
      process.env['ADHD_BACKLOG_DATABASE_PATH'] = h.dbPath;
      process.exitCode = undefined;
      await runBacklogCli(['store-check'], { adhdRoot: h.dir });
      expect(process.exitCode).toBe(1);

      const text = errText();
      expect(text).toContain('unflagged-terminal (1)');
      expect(text).toContain('status "closed"');
      expect(text).toContain(`uid ${closedUid}`);
      expect(text).toContain('planTerminalBackfill');
      expect(text).toContain('applyTerminalBackfill');
      expect(text).toContain('case-fragment-duplicate (1)');
      expect(text).toContain('fold "high"');
      expect(text).toContain(`"HIGH" (uid ${upper.uid})`);
      expect(text).toContain(`"high" (uid ${lower.uid})`);
      expect(text).toContain('planCaseFragmentMerge');
      expect(text).toContain('applyCaseFragmentMerge');

      // NEGATIVE CONTROL — run the EXACT repair the message names.
      const repair = await openGraphBacklogStore(h.dbPath);
      try {
        await applyTerminalBackfill(repair, await planTerminalBackfill(repair));
        const statuses = await repair.graph.queryNodes({
          kind: 'status',
          liveOnly: true,
        });
        const priorities = await repair.graph.queryNodes({
          kind: 'priority',
          liveOnly: true,
        });
        await applyCaseFragmentMerge(
          repair,
          planCaseFragmentMerge(statuses, priorities)
        );
      } finally {
        await repair.adapter.close();
      }

      process.exitCode = undefined;
      logSpy.mockClear();
      errSpy.mockClear();
      await runBacklogCli(['store-check'], { adhdRoot: h.dir });
      // Green means "the process would exit 0": the success branch prints and
      // returns without ever setting `process.exitCode`, which stays undefined
      // (Node exits 0). The violation branch above set it to 1.
      expect(process.exitCode ?? 0).toBe(0);
      expect(logText()).toContain('"ok":true');
      expect(errText()).not.toContain('unflagged-terminal');
    },
    TIMEOUT
  );
});
