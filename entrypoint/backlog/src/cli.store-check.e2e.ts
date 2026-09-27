/**
 * cli.store-check.e2e.ts — the `store-check` special command (BUG-BACKLOG-005),
 * proven the way a real operator invokes it: by SPAWNING the REAL BUILT
 * `dist/index.js` as a genuine child process (`process.execPath dist/index.js
 * store-check`) against a real, temp-scoped store — never an in-process bypass.
 *
 * `store-check` is the operator-facing diagnostic for a store whose node
 * vocabulary this build does not recognize. Without it, a full store whose
 * items sit under another build's vocabulary reads as `{ok:true, total:0}` —
 * a healthy store looks empty and every caller is told it succeeded. The
 * command opens the store (read-only) and reports the expected vocabulary
 * against the kinds actually present, exiting non-zero on a mismatch.
 *
 * TEETH (AGENTS.md §7): the two cases below are the exact pair that must
 * disagree — a recognized store exits 0 with `ok:true`, a foreign-vocabulary
 * store exits 1 with `code:'store_vocabulary_mismatch'`. Removing the guard
 * from `openGraphBacklogStore` makes the second case exit 0 (the store opens
 * and reads as empty), turning this file red.
 *
 * The foreign-vocabulary fixture is built with the REAL write primitive
 * (`writeNodeTx`), the same hand-composed path every write verb uses, so the
 * fixture is a genuine foreign store rather than a hand-poked row — mirroring
 * `store/vocabulary-guard.spec.ts`'s own `seedForeignNode` helper. The store is
 * seeded through `openTestIssueStore` (which does NOT run the guard), closed,
 * and only THEN handed to the spawned bin.
 *
 * Isolation: every spawn routes through `test/helpers/spawn-backlog-bin.ts`'s
 * `mintBacklogSandbox`/`runInBacklogSandbox` — the canonical, `--namespace
 * sandbox`-forcing helper — so nothing here touches the real machine's global
 * backlog graph.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  openTestIssueStore,
  seedProject,
  type TestIssueStore,
} from './test/helpers/open-test-issue-store.js';
import { writeNodeTx, nowISO } from './write/tx.js';
import {
  planTerminalBackfill,
  applyTerminalBackfill,
} from './write/catalog-repair.js';
import {
  planCaseFragmentMerge,
  applyCaseFragmentMerge,
} from './write/catalog-merge.js';
import {
  mintBacklogSandbox,
  runInBacklogSandbox,
} from './test/helpers/spawn-backlog-bin.js';

/** Sandbox roots minted by this file — removed after every test. */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes one live node of a kind this build does NOT recognize, through the
 * REAL `writeNodeTx` primitive (open vocabulary — the DB has no kind CHECK
 * constraint), so the store's live vocabulary is entirely foreign.
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
 * Seed the two catalog violations the check detects, through the REAL
 * `writeNodeTx` primitive (the same hand-composed path every write verb uses):
 *  - a live `status` named `closed` with NO `metadata.terminal`;
 *  - a `priority` pair `HIGH`/`high` that folds to one token.
 * Returns the uids so the assertions can name the exact offending rows.
 */
async function seedCatalogViolation(store: TestIssueStore): Promise<{
  closedUid: string;
  upperUid: string;
  lowerUid: string;
}> {
  return store.adapter.transaction(
    async (tx) => {
      const closed = await writeNodeTx(tx, {
        kind: 'status',
        name: 'closed',
        at: nowISO(),
      });
      const upper = await writeNodeTx(tx, {
        kind: 'priority',
        name: 'HIGH',
        metadata: { rank: 1 },
        at: nowISO(),
      });
      const lower = await writeNodeTx(tx, {
        kind: 'priority',
        name: 'high',
        metadata: { rank: 2 },
        at: nowISO(),
      });
      return {
        closedUid: closed.uid,
        upperUid: upper.uid,
        lowerUid: lower.uid,
      };
    },
    { mode: 'immediate' }
  );
}

/** The last stdout/stderr line — `store-check` prints exactly one JSON object. */
function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trim().split('\n').pop() ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('store-check special command — real spawned dist/index.js bin', () => {
  it('exits 0 with ok:true on a store this build recognizes', async () => {
    const sandbox = mintBacklogSandbox();
    dirs.push(sandbox.adhdRoot);

    // Seed a recognized project (+ its reserved component) BEFORE the spawned
    // bin owns the file, then close so the child opens it cleanly.
    const store = await openTestIssueStore(sandbox.dbPath);
    try {
      await seedProject(store, 'recognized');
    } finally {
      await store.close();
    }

    const res = runInBacklogSandbox(sandbox, ['store-check']);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = lastJson(res.stdout);
    expect(body['ok']).toBe(true);
    expect(body['total']).toBeGreaterThan(0);
    const kinds = (body['kinds'] as Array<{ kind: string }>).map((k) => k.kind);
    expect(kinds).toContain('project');
    expect(body['expectedKinds']).toContain('issue');
  });

  it('exits 1 with code store_vocabulary_mismatch on a foreign-vocabulary store', async () => {
    const sandbox = mintBacklogSandbox();
    dirs.push(sandbox.adhdRoot);

    // A store whose live nodes are ENTIRELY of a foreign kind — the exact
    // shape that would otherwise read as `{ok:true, total:0}`.
    const store = await openTestIssueStore(sandbox.dbPath);
    try {
      await seedForeignNode(store, 'generic');
      await seedForeignNode(store, 'entity');
    } finally {
      await store.close();
    }

    const res = runInBacklogSandbox(sandbox, ['store-check']);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      1
    );
    // The failure report goes to stderr (the success report to stdout) — see
    // cli.ts's `store-check` branch. Never assume a single line: take the last.
    const body = lastJson(res.stderr);
    expect(body['ok']).toBe(false);
    expect((body['error'] as { code: string }).code).toBe(
      'store_vocabulary_mismatch'
    );
    expect(body['observed']).toEqual(
      expect.arrayContaining([
        { kind: 'generic', count: 1 },
        { kind: 'entity', count: 1 },
      ])
    );
  });

  it('exits non-zero naming every offending row on a catalog-violating store, then goes green once the NAMED remediation is run', async () => {
    const sandbox = mintBacklogSandbox();
    dirs.push(sandbox.adhdRoot);

    const store = await openTestIssueStore(sandbox.dbPath);
    let seeded: { closedUid: string; upperUid: string; lowerUid: string };
    try {
      seeded = await seedCatalogViolation(store);
    } finally {
      await store.close();
    }

    // The check MUST fail loudly and non-zero, printing the guard's OWN message
    // verbatim: uid + name; fold + both spellings; and the exact remediation.
    const res = runInBacklogSandbox(sandbox, ['store-check']);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(
      1
    );
    expect(res.stderr).toContain('unflagged-terminal (1)');
    expect(res.stderr).toContain('status "closed"');
    expect(res.stderr).toContain(`uid ${seeded.closedUid}`);
    expect(res.stderr).toContain('planTerminalBackfill');
    expect(res.stderr).toContain('applyTerminalBackfill');
    expect(res.stderr).toContain('case-fragment-duplicate (1)');
    expect(res.stderr).toContain('fold "high"');
    expect(res.stderr).toContain(`"HIGH" (uid ${seeded.upperUid})`);
    expect(res.stderr).toContain(`"high" (uid ${seeded.lowerUid})`);
    expect(res.stderr).toContain('planCaseFragmentMerge');
    expect(res.stderr).toContain('applyCaseFragmentMerge');
    // ... plus a machine-readable failure envelope on the last line.
    const body = lastJson(res.stderr);
    expect(body['ok']).toBe(false);
    expect((body['error'] as { code: string }).code).toBe(
      'catalog_invariant_violation'
    );

    // NEGATIVE CONTROL — same store, run the EXACT remediation the message
    // names (`planTerminalBackfill`/`applyTerminalBackfill` and
    // `planCaseFragmentMerge`/`applyCaseFragmentMerge`), and the check goes
    // GREEN. This makes the check falsifiable rather than decorative: the only
    // change between the two spawns is the repair.
    const repair = await openTestIssueStore(sandbox.dbPath);
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
      await repair.close();
    }

    const green = runInBacklogSandbox(sandbox, ['store-check']);
    expect(green.status, `stdout:\n${green.stdout}\nstderr:\n${green.stderr}`).toBe(
      0
    );
    expect(lastJson(green.stdout)['ok']).toBe(true);
  });
});
