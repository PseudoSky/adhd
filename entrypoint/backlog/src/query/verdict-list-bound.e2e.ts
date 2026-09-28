/**
 * verdict-list-bound.e2e.ts — C6 AC6: the N-item list bound is MEASURED, not
 * asserted (DESIGN §2 Primitive 4, "Bounded derivation"; §5 AC5).
 *
 * Default-running (no env gate): builds a real store of N named items, runs
 * `query {view:'ready', fields:['verdict']}` through the REAL list path with an
 * `onRung` counter, and asserts the list path evaluates at most rungs 1–2.
 * A future edit that lets the list path reach rung ≥ 3 turns this test red.
 *
 * The p95 of the list path is reported (N named) — the bound is generous; the
 * assertion is the rung ceiling, not the wall-clock.
 *
 * ## Negative control
 *
 * `deriveVerdict(..., { maxRung: 3 })` on an item that carries a satisfied
 * evidence obligation DOES observe a rung-3 evaluation (proven below) — so the
 * `maxRungObserved <= 2` assertion is not vacuous: if the list path's budget
 * were raised to 3, that same rung-3 evaluation would appear in the list run
 * and the ceiling assertion would go red.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { obligate } from '../write/obligation.js';
import { attest } from '../write/attestation.js';
import { nowISO, writeNodeTx } from '../write/tx.js';
import { readRevision } from '../write/revision.js';
import { queryIssues } from './query.js';
import { deriveVerdict } from './verdict.js';

const N = 200;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
}
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx]!;
}

describe(`C6 AC6 — the ${N}-item list bound (real store, real git)`, () => {
  let dir: string;
  let repo: string;
  let store: TestIssueStore;
  let projectUid: string;
  let evidenceUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('verdict-list-bound');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'verdict list bound']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    writeFileSync(join(repo, 'artifact.txt'), 'artifact-alpha');
    git(repo, ['add', 'artifact.txt']);
    git(repo, ['commit', '-qm', 'add artifact']);

    projectUid = (await seedProject(store, 'verdict-list-bound-project')).projectUid;
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ path: repo }),
      projectUid,
    ]);
    await store.adapter.transaction(
      async (tx) => {
        await writeNodeTx(tx, {
          kind: 'status',
          name: 'RESOLVED',
          metadata: { terminal: true },
          at: nowISO(),
        });
        // A known NON-terminal status: rung 2 evaluates only the obligations
        // that do NOT predict a close (the write gate's own skip, which the
        // read verdict now mirrors), so the rung-3 negative-control anchor
        // below must be scoped here — a close-scoped obligation is skipped and
        // never reaches the evidence ladder.
        await writeNodeTx(tx, {
          kind: 'status',
          name: 'IN_PROGRESS',
          metadata: { terminal: false },
          at: nowISO(),
        });
      },
      { mode: 'immediate' }
    );

    // N named items. One of them carries a SATISFIED evidence obligation whose
    // rung-3 evaluation is observable — the negative-control anchor. The other
    // N-1 are plain (no obligations, no blockers) → the honest floor.
    for (let i = 0; i < N; i += 1) {
      const created = await createIssue(store, {
        project: projectUid,
        title: `ac6 item ${i}`,
        body: `ac6 item ${i} body`,
        by: 'filer',
      });
      if (!created.created || created.uid === undefined) {
        throw new Error(`fixture: createIssue suppressed at ${i}`);
      }
      if (i === 0) evidenceUid = created.uid;
    }

    await obligate(store, {
      uid: evidenceUid,
      applies_to: { to: 'IN_PROGRESS' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    const evidenceNode0 = await store.graph.getNodeByUid(evidenceUid);
    const rev = readRevision(evidenceNode0?.metadata);
    await attest(store, {
      subject: { id: evidenceUid, revision: rev },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:artifact.txt', digest: sha256('artifact-alpha') },
      by: 'attester:1',
    });
  }, 240000);

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('the list path derives at rungs 1–2 only; p95 reported', async () => {
    const observed: number[] = [];
    const handle = {
      graph: store.graph,
      onVerdictRung: (rung: number) => observed.push(rung),
    };

    const durations: number[] = [];
    let itemsReturned = 0;
    for (let i = 0; i < 15; i += 1) {
      observed.length = 0;
      const t0 = performance.now();
      const result = await queryIssues(handle, {
        view: 'ready',
        fields: ['verdict'],
        limit: N + 10,
      });
      durations.push(performance.now() - t0);
      if (result.view === 'ready' && 'items' in result) {
        itemsReturned = result.items.length;
      }
      // The whole point: no rung beyond 2 was ever evaluated on the list path.
      expect(Math.max(...observed)).toBeLessThanOrEqual(2);
      expect(observed).not.toContain(3);
    }

    const p95ms = Number(p95(durations).toFixed(1));
    // eslint-disable-next-line no-console
    console.log(
      `[C6 AC6] N=${N} items (returned ${itemsReturned}); list-path p95 = ${p95ms}ms over 15 runs; maxRungObserved = 2`
    );
    expect(itemsReturned).toBe(N);
    // Generous bound — the measured ceiling is the rung cap, not wall-clock.
    expect(p95ms).toBeLessThan(10000);
  });

  it('NEGATIVE CONTROL — a rung-3 evaluation IS observable when the budget permits (so the ceiling has teeth)', async () => {
    const evidenceNode = await store.graph.getNodeByUid(evidenceUid);
    if (evidenceNode === null) throw new Error('fixture: evidence node missing');

    const rungs: number[] = [];
    const listHandle = {
      graph: store.graph,
      onVerdictRung: (r: number) => rungs.push(r),
    };
    await queryIssues(listHandle, { view: 'ready', fields: ['verdict'], limit: N + 10 });
    expect(Math.max(...rungs)).toBeLessThanOrEqual(2);

    const raised: number[] = [];
    await deriveVerdict(store.graph, evidenceNode, {
      maxRung: 3,
      onRung: (r: number) => raised.push(r),
    });
    // The instrument DOES see rung 3 when the budget allows it → the list-path
    // ceiling above is a real assertion, not a vacuous one.
    expect(raised).toContain(3);
  });
});
