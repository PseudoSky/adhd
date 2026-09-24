/**
 * vocabulary-guard.e2e.ts — the fail-loud guard against a store written
 * under a node vocabulary this build does not recognize (BUG-BACKLOG-005).
 *
 * The defect: a full store whose items sit under another build's vocabulary
 * reads as `{ok:true, total:0}` — a healthy store looks empty and every caller
 * is told it succeeded. These tests pin the guard that converts that silence
 * into one self-explaining failure.
 *
 * TEETH: the integration case (`query path ...`) is RED if the
 * `await handle.assertVocabulary?.()` call is removed from
 * `queryIssuesWithMeta`, and the store-open case is RED if
 * `assertRecognizedStoreVocabulary` is removed from `openGraphBacklogStore`.
 * Both were verified by temporarily removing each call and re-running — see
 * the test's own `expect` messages.
 *
 * TEETH (bounded criterion, finding 8ca66712): the `bounded criterion probe`
 * suite observes the exact SQL the guard issues. It is RED if the guard reverts
 * to running `inspectStoreVocabulary`'s `GROUP BY kind` histogram on the
 * healthy path (the probe test would then see two statements, the second a
 * histogram, instead of one `LIMIT 1` probe). Verified by temporarily reverting
 * `assertRecognizedStoreVocabulary` to the unconditional-histogram form and
 * re-running: `short-circuits ...` goes RED. No sleeps — the observation is a
 * statement recording, not timing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openGraphBacklogStore, closeGraphBacklogStore } from './graph-backlog-store.js';
import {
  assertRecognizedStoreVocabulary,
  inspectStoreVocabulary,
  StoreVocabularyMismatchError,
  ITEM_NODE_KIND,
  RECOGNIZED_NODE_KINDS,
} from './vocabulary-guard.js';
import { queryIssuesWithMeta, type IQueryStoreHandle } from '../query/query.js';
import { writeNodeTx, nowISO } from '../write/tx.js';
import {
  openTestIssueStore,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

/**
 * Writes one live node of a kind this build does NOT recognize, through the
 * REAL write primitive — the same hand-composed `writeNodeTx` path every
 * write verb uses, so the fixture is a genuine foreign-vocabulary store and
 * not a hand-poked row.
 */
async function seedForeignNode(
  store: TestIssueStore,
  kind = 'generic'
): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      await writeNodeTx(tx, { kind, name: 'legacy-item', at: nowISO() });
    },
    { mode: 'immediate' }
  );
}

/**
 * Writes one live node of a RECOGNIZED kind (`note` by default) through the
 * real write primitive — used to grow a healthy store so the bounded probe has
 * many recognized rows to short-circuit past.
 */
async function seedRecognizedNode(
  store: TestIssueStore,
  name: string,
  kind = 'note'
): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      await writeNodeTx(tx, { kind, name, at: nowISO() });
    },
    { mode: 'immediate' }
  );
}

/**
 * A recording proxy around the real adapter: every `executeAll` call is
 * appended to `statements` and delegated to the real adapter. This is how the
 * bounded-probe tests observe WHICH queries the guard issued — a deterministic
 * statement count, never a timing measurement.
 */
function recordingAdapter(adapter: StoreAdapter): {
  adapter: StoreAdapter;
  statements: string[];
} {
  const statements: string[] = [];
  const proxy = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'executeAll') {
        return (sql: string, args?: unknown[]) => {
          statements.push(sql);
          return target.executeAll(sql, args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StoreAdapter;
  return { adapter: proxy, statements };
}

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = freshTmpDir('vocabulary-guard-');
  dirs.push(dir);
  return join(dir, 'backlog.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('assertRecognizedStoreVocabulary — the criterion', () => {
  it('passes on an empty store (a fresh store legitimately has no items)', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      await expect(
        assertRecognizedStoreVocabulary(store.adapter)
      ).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('passes on a store holding only recognized catalog rows (item-empty ≠ unrecognized)', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      await seedProject(store, 'adhd');
      const { total, observed } = await inspectStoreVocabulary(store.adapter);
      expect(total).toBeGreaterThan(0);
      expect(observed.map((o) => o.kind)).toContain('project');
      await expect(
        assertRecognizedStoreVocabulary(store.adapter)
      ).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('throws on a store whose live nodes are ENTIRELY foreign, naming expected + observed', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      await seedForeignNode(store, 'generic');
      await seedForeignNode(store, 'entity');
      let caught: unknown;
      try {
        await assertRecognizedStoreVocabulary(store.adapter);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StoreVocabularyMismatchError);
      const err = caught as StoreVocabularyMismatchError;
      // The message names the expected vocabulary, the observed vocabulary,
      // and the likely cause — an operator is never left guessing.
      expect(err.message).toContain(ITEM_NODE_KIND);
      expect(err.message).toContain('generic=1');
      expect(err.message).toContain('entity=1');
      expect(err.message.toLowerCase()).toContain('vocabulary');
      expect(err.observed).toEqual(
        expect.arrayContaining([
          { kind: 'generic', count: 1 },
          { kind: 'entity', count: 1 },
        ])
      );
      expect(err.recognized).toEqual(expect.arrayContaining(['issue', 'project']));
    } finally {
      await store.close();
    }
  });
});

describe('query path — a full foreign-vocabulary store must never read as 0', () => {
  it('rejects through the guard instead of returning {ok:true,total:0}', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      await seedForeignNode(store, 'generic');
      await seedForeignNode(store, 'generic');

      // Positive control for the BUG: WITHOUT the guard wired, the exact same
      // store reads as a successful, empty result — this is the silent data
      // loss the guard exists to stop, pinned here so the difference is
      // explicit rather than asserted.
      const unguarded: IQueryStoreHandle = { graph: store.graph };
      const silent = await queryIssuesWithMeta(unguarded, {});
      expect(silent.result).toMatchObject({
        view: 'list',
        items: [],
        hasMore: false,
      });
      expect(silent.meta?.total).toBe(0);

      // With the guard wired (as `api.ts`'s `queryHandle` does for every real
      // host), the same read fails loudly. TEETH: remove the
      // `await handle.assertVocabulary?.()` call from `queryIssuesWithMeta`
      // and this expectation goes RED (it would resolve to the silent result
      // above instead of rejecting).
      const guarded: IQueryStoreHandle = {
        graph: store.graph,
        assertVocabulary: () =>
          assertRecognizedStoreVocabulary(store.adapter),
      };
      await expect(queryIssuesWithMeta(guarded, {})).rejects.toBeInstanceOf(
        StoreVocabularyMismatchError
      );
    } finally {
      await store.close();
    }
  });

  it('succeeds normally against a store that holds the expected vocabulary', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      await seedProject(store, 'adhd');
      const guarded: IQueryStoreHandle = {
        graph: store.graph,
        assertVocabulary: () =>
          assertRecognizedStoreVocabulary(store.adapter),
      };
      const outcome = await queryIssuesWithMeta(guarded, {});
      expect(outcome.result).toMatchObject({
        view: 'list',
        items: [],
        hasMore: false,
      });
      expect(outcome.meta?.total).toBe(0);
    } finally {
      await store.close();
    }
  });
});

describe('store open — startup guard', () => {
  it('refuses to open a foreign-vocabulary store (fails loud, does not serve emptiness)', async () => {
    const dbPath = tmpDbPath();
    const seed = await openTestIssueStore(dbPath);
    await seedForeignNode(seed, 'generic');
    await seedForeignNode(seed, 'generic');
    await seedForeignNode(seed, 'generic');
    await seed.close();

    // TEETH: remove the `assertRecognizedStoreVocabulary(adapter)` call from
    // `openGraphBacklogStore` and this goes RED — the store opens and the
    // query path would then serve `{ok:true,total:0}`.
    await expect(openGraphBacklogStore(dbPath)).rejects.toBeInstanceOf(
      StoreVocabularyMismatchError
    );
  });

  it('opens a store that holds the expected vocabulary', async () => {
    const dbPath = tmpDbPath();
    const seed = await openTestIssueStore(dbPath);
    await seedProject(seed, 'adhd');
    await seed.close();

    const store = await openGraphBacklogStore(dbPath);
    try {
      const { total, observed } = await inspectStoreVocabulary(store.adapter);
      expect(total).toBeGreaterThan(0);
      expect(observed.map((o) => o.kind)).toContain('project');
      expect([...RECOGNIZED_NODE_KINDS]).toContain('issue');
    } finally {
      await closeGraphBacklogStore(store);
    }
  });
});

describe('bounded criterion probe — the healthy path is one LIMIT 1, not a scan', () => {
  it('short-circuits on a LARGE healthy store: exactly one statement, a LIMIT-1 probe, no histogram', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      // Grow the store well past a handful of rows: 200 recognized live nodes
      // plus the seeded project/component. If the guard still ran the full
      // histogram, it would scan all of them and the statement count below
      // would be 2, not 1 — the assertion that pins the bounded path.
      await seedProject(store, 'adhd');
      for (let i = 0; i < 200; i += 1) {
        await seedRecognizedNode(store, `note-${i}`);
      }

      const rec = recordingAdapter(store.adapter);
      await expect(
        assertRecognizedStoreVocabulary(rec.adapter)
      ).resolves.toBeUndefined();

      expect(rec.statements).toHaveLength(1);
      expect(rec.statements[0]).toContain('LIMIT 1');
      expect(rec.statements[0]).not.toContain('GROUP BY');
    } finally {
      await store.close();
    }
  });

  it('falls back to the histogram only when no recognized node exists — and throws with it', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      await seedForeignNode(store, 'generic');

      const rec = recordingAdapter(store.adapter);
      await expect(
        assertRecognizedStoreVocabulary(rec.adapter)
      ).rejects.toBeInstanceOf(StoreVocabularyMismatchError);

      // Probe first (bounded), then the histogram — the latter only because
      // the probe found nothing, and only to build the refusal's diagnostic.
      expect(rec.statements).toHaveLength(2);
      expect(rec.statements[0]).toContain('LIMIT 1');
      expect(rec.statements[1]).toContain('GROUP BY');
    } finally {
      await store.close();
    }
  });

  it('pays the histogram for an EMPTY store (no recognized node) but still passes', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      const rec = recordingAdapter(store.adapter);
      await expect(
        assertRecognizedStoreVocabulary(rec.adapter)
      ).resolves.toBeUndefined();
      // Empty store: probe finds nothing, histogram runs and reports zero —
      // a true zero, never a refusal.
      expect(rec.statements).toHaveLength(2);
      expect(rec.statements[1]).toContain('GROUP BY');
    } finally {
      await store.close();
    }
  });
});
