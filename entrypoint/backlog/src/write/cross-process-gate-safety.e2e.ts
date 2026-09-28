/**
 * cross-process-gate-safety.e2e.ts — C5 AC5: the closure gate is safe under
 * concurrency (adhd ADR-0001 + ADR-0012 — parallel-process enabled).
 *
 * The gate evaluates INSIDE `transition`'s existing `BEGIN IMMEDIATE`
 * transaction, so two REAL OS processes attempting the SAME terminal
 * transition serialize through the RESERVED lock: the first commits evidence
 * the second then observes, and the second is REFUSED — never a lost update,
 * never a torn state. The obligation under test is a genuine re-close guard:
 * `not { relation: has_transition (out) }` — "this item must not already have
 * a transition" — so the winner's own write is exactly the fact the loser's
 * gate must see.
 *
 * **Determinism (AGENTS.md §7 rule 3).** Two REAL OS processes (never
 * `worker_threads`), synchronized by a file-based start barrier (both park on
 * their own `ready-<tag>` file; the parent touches a shared `GO` only once
 * BOTH exist) — never a `sleep`. Persistence is verified by reopening the
 * store FRESH; the runner's exit code is trusted, not stdout.
 *
 * The `ADHD_BACKLOG_UNSAFE_TX_MODE=deferred` negative control strips the
 * `BEGIN IMMEDIATE` CAS guarantee; the invariant asserted here is expected to
 * fail under it (both writers observe the pre-write state), which is what
 * proves the CONTROL is exercising the real guarantee.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  seedProject,
  removeTestIssueStoreDir,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { obligate } from '../write/obligation.js';
import { nowISO, writeNodeTx } from '../write/tx.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, '..', 'test', 'fixtures', 'cross-process-gate-worker.ts');
const TSX_BIN = join(HERE, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');

interface WorkerOutcome {
  tag: string;
  outcome: 'success' | 'refused' | 'error';
  code?: string;
  message?: string;
}

function spawnWorker(
  dbPath: string,
  tag: string,
  issueUid: string,
  root: string,
  toStatus: string,
  env?: Record<string, string>
): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [WORKER_SCRIPT, dbPath, tag, issueUid, root, toStatus], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      const lastLine = out.trim().split('\n').filter(Boolean).pop();
      if (!lastLine) {
        reject(
          new Error(
            `gate worker ${tag} exited ${code} with no JSON outcome line. stderr: ${err.slice(-500)}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(lastLine) as WorkerOutcome);
      } catch {
        reject(
          new Error(
            `gate worker ${tag} exited ${code}, stdout did not parse as JSON: ${lastLine}`
          )
        );
      }
    });
  });
}

/** Runs two writers concurrently through the file barrier: both park on `ready-<tag>`, `GO` is touched once BOTH are parked. Bounded wait, never a sleep-based race. */
async function runBarrieredPair(
  dbPath: string,
  root: string,
  issueUid: string,
  toStatus: string,
  env?: Record<string, string>
): Promise<[WorkerOutcome, WorkerOutcome]> {
  const readyA = join(root, 'ready-A');
  const readyB = join(root, 'ready-B');
  const go = join(root, 'GO');
  for (const f of [readyA, readyB, go]) rmSync(f, { force: true });

  let earlyFailure: unknown;
  const wA = spawnWorker(dbPath, 'A', issueUid, root, toStatus, env).catch((err) => {
    earlyFailure ??= err;
    throw err;
  });
  const wB = spawnWorker(dbPath, 'B', issueUid, root, toStatus, env).catch((err) => {
    earlyFailure ??= err;
    throw err;
  });
  const pair = Promise.all([wA, wB]);
  pair.catch(() => {
    /* handled — surfaced via the await below or earlyFailure */
  });

  const deadline = Date.now() + 30000;
  while (!(existsSync(readyA) && existsSync(readyB))) {
    if (earlyFailure !== undefined) {
      throw new Error(
        `a gate worker failed before reaching the start barrier: ${
          earlyFailure instanceof Error ? earlyFailure.message : String(earlyFailure)
        }`
      );
    }
    if (Date.now() > deadline) throw new Error('gate workers never reached the barrier');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  writeFileSync(go, 'go');
  return pair;
}

interface PostState {
  transitions: number;
  status: string | undefined;
}

/** Fresh-reopen read: live `has_transition` count + the issue's live status name. */
async function readPostState(dbPath: string, issueUid: string): Promise<PostState> {
  const store = await openTestIssueStore(dbPath);
  try {
    const issue = await store.adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL',
      [issueUid]
    );
    if (!issue) throw new Error(`readPostState: no live issue for uid ${issueUid}`);
    const transitions = await store.adapter.executeGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM edge WHERE src = ? AND rel = 'has_transition' AND t_invalid IS NULL",
      [issue.rowid]
    );
    const status = await store.adapter.executeGet<{ name: string | null }>(
      `SELECT s.name AS name FROM edge e JOIN node s ON s.rowid = e.dst
        WHERE e.src = ? AND e.rel = 'has_status' AND e.t_invalid IS NULL
        ORDER BY e.rowid DESC LIMIT 1`,
      [issue.rowid]
    );
    return {
      transitions: transitions?.n ?? 0,
      status: status?.name ?? undefined,
    };
  } finally {
    await store.close();
  }
}

describe('C5 closure gate — cross-process concurrency safety (AC5)', () => {
  let dir: string;
  let dbPath: string;
  let issueUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('cross-process-gate-safety');
    dbPath = join(dir, 'backlog.db');
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(seedStore, 'cross-process-gate-project');
    const created = await createIssue(seedStore, {
      project: projectUid,
      title: 'gated close subject',
      body: 'b',
      by: 'filer',
    });
    if (!created.created || created.uid === undefined) {
      throw new Error('fixture: createIssue suppressed');
    }
    issueUid = created.uid;
    await seedStore.adapter.transaction(
      async (tx) => {
        await writeNodeTx(tx, {
          kind: 'status',
          name: 'done',
          metadata: { terminal: true },
          at: nowISO(),
        });
      },
      { mode: 'immediate' }
    );
    // The re-close guard: the item must not already have a transition.
    await obligate(seedStore, {
      uid: issueUid,
      applies_to: { to: 'done' },
      requirement: {
        op: 'not',
        of: { op: 'relation', type: 'has_transition', direction: 'out' },
      },
      on_fail: 'block',
      by: 'declarer:1',
    });
    await seedStore.close();
  });

  afterEach(() => {
    removeTestIssueStoreDir(dir);
  });

  it('CONTROL (immediate): two REAL processes racing the terminal transition yield exactly one success, one refusal; one has_transition; no lost update', async () => {
    const [a, b] = await runBarrieredPair(dbPath, dir, issueUid, 'done');

    const outcomes = [a.outcome, b.outcome].sort();
    expect(
      outcomes,
      `expected exactly [refused, success], got [${outcomes}] (A=${JSON.stringify(a)}, B=${JSON.stringify(b)})`
    ).toEqual(['refused', 'success']);
    // No raw store/contention error reached either caller.
    expect(a.outcome).not.toBe('error');
    expect(b.outcome).not.toBe('error');
    const loser = a.outcome === 'refused' ? a : b;
    // The refusal is a typed reason (the re-close guard's `not` leaf yields
    // `Unknown`; a leaf-shaped obligation yields its own code) — never a raw
    // store error.
    expect(typeof loser.code).toBe('string');
    expect((loser.code ?? '').length).toBeGreaterThan(0);

    const post = await readPostState(dbPath, issueUid);
    expect(post.transitions).toBe(1); // exactly one transition — no lost update, no double-close
    expect(post.status).toBe('done'); // consistent terminal status
  }, 60000);

  it('NEGATIVE CONTROL (deferred): ADHD_BACKLOG_UNSAFE_TX_MODE=deferred strips the BEGIN IMMEDIATE CAS guarantee — the exactly-one invariant must break', async () => {
    const [a, b] = await runBarrieredPair(dbPath, dir, issueUid, 'done', {
      ADHD_BACKLOG_UNSAFE_TX_MODE: 'deferred',
    });
    const post = await readPostState(dbPath, issueUid);

    // eslint-disable-next-line no-console
    console.warn(
      `[cross-process-gate-safety] NEGATIVE CONTROL numbers: A=${JSON.stringify(a)} B=${JSON.stringify(b)} ` +
        `transitions=${post.transitions} status=${post.status}`
    );

    // THE invariant the CONTROL proves under `immediate` — exactly one clean
    // success, one typed refusal, one transition, and NO raw store error
    // reaching a caller — is expected to BREAK here: with the RESERVED-lock
    // CAS stripped, the loser wakes on a stale snapshot and surfaces a raw
    // driver error (`step failed: Database snapshot is stale…`) instead of a
    // clean refusal. This is what makes the CONTROL meaningful.
    const outcomes = [a.outcome, b.outcome].sort();
    const cleanOneSuccessOneRefusal =
      outcomes[0] === 'refused' &&
      outcomes[1] === 'success' &&
      !outcomes.includes('error') &&
      post.transitions === 1;
    expect(
      cleanOneSuccessOneRefusal,
      `deferred mode: expected the exactly-one-clean invariant to break, got [${outcomes}] ` +
        `with transitions=${post.transitions} (A=${JSON.stringify(a)}, B=${JSON.stringify(b)})`
    ).toBe(false);
  }, 60000);
});
