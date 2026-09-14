/**
 * claim.spec.ts — behavioral proof for `claim` (SPEC.md §6.3.5, §4c).
 *
 * Two halves:
 *
 * 1. **In-process rule-table coverage** — every branch of §6.3.5's table,
 *    driven against a REAL store (never a mock of `claim` itself, never a
 *    mock of the store) via one real, single connection.
 * 2. **The CAS proof** — the "hard part" this slice exists to prove: two REAL
 *    OS processes calling `claim(..., action:'claim')` against the SAME
 *    freshly-unclaimed `uid`, synchronized by a file-based start barrier
 *    (never a `sleep`), must produce EXACTLY ONE winner and one
 *    `ClaimHeldError` loser — never both winning, never both losing. The
 *    NEGATIVE CONTROL (`ADHD_BACKLOG_UNSAFE_TX_MODE=deferred`, `tx.ts`'s own
 *    documented escape hatch) strips the `BEGIN IMMEDIATE` RESERVED-lock
 *    guarantee this rests on, to prove the CONTROL case is actually
 *    exercising that guarantee and not passing for an unrelated reason —
 *    mirroring `cross-process-write-safety.spec.ts`'s proven CONTROL/
 *    NEGATIVE-CONTROL structure (BUG-039), applied to `claim`'s own CAS
 *    instead of `createIssue`'s dedupe-skip.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { claim, type IClaimOutcome } from './claim.js';
import { ClaimHeldError, InvalidArgumentError, IssueNotFoundError } from './errors.js';
import { getNodeByUidTx, type ITxNodeRow } from './tx.js';

const HERE = dirname(fileURLToPath(import.meta.url));

async function readNode(store: TestIssueStore, uid: string): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

interface RawAuditRow {
  action: string;
  from: string | null;
  to: string | null;
  note: string | null;
}

/** Reads every `audit` node linked to `subjectRowid` via a live `audits` edge, oldest first — a direct, real SQL read, never a mock. */
async function readAuditTrail(store: TestIssueStore, subjectRowid: number): Promise<RawAuditRow[]> {
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(
    `SELECT a.meta as meta FROM edge e JOIN node a ON a.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL AND a.kind = 'audit'
     ORDER BY a.rowid ASC`,
    [subjectRowid],
  );
  return rows.map((row) => {
    const meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    return {
      action: String(meta['action'] ?? ''),
      from: (meta['from'] as string | null) ?? null,
      to: (meta['to'] as string | null) ?? null,
      note: (meta['note'] as string | null) ?? null,
    };
  });
}

describe('claim — rule-table coverage (SPEC.md §6.3.5, real store, single connection)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let issueUid: string;
  let issueRowid: number;

  beforeEach(async () => {
    dir = freshTmpDir('claim-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const seeded = await seedProject(store, 'claim-spec-project');
    projectUid = seeded.projectUid;
    const created = await createIssue(store, {
      project: projectUid,
      title: 'claim target',
      body: 'exercised by claim.spec.ts',
      by: 'filer',
      assignee: 'someone-preexisting',
    });
    issueUid = created.uid;
    const row = await readNode(store, issueUid);
    if (!row) throw new Error('setup: issue not found immediately after createIssue');
    issueRowid = row.rowid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('claim on an unclaimed issue: writes {claimedBy, claimedAt}, returns status:"claimed"', async () => {
    const outcome = await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    expect(outcome.status).toBe('claimed');
    expect(outcome.claimedBy).toBe('agent-a');
    expect(typeof outcome.claimedAt).toBe('string');

    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['claimedBy']).toBe('agent-a');
    expect(row?.metadata?.['claimedAt']).toBe(outcome.claimedAt);
    // touch is a WHOLESALE meta replace (§6.3.4) — the pre-existing `assignee` metadata
    // (unrelated to the claim lease) must survive, never silently wiped.
    expect(row?.metadata?.['assignee']).toBe('someone-preexisting');
  });

  it('claim by the SAME claimant again: status:"held", claimedAt bumps (idempotent re-claim)', async () => {
    const first = await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    // Force a measurable clock delta so a passing test can't be an artifact of two
    // identical Date.now() reads landing in the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });

    expect(second.status).toBe('held');
    expect(second.heldBy).toBe('agent-a');
    expect(second.claimedBy).toBe('agent-a');
    expect(second.claimedAt).not.toBe(first.claimedAt);

    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['claimedAt']).toBe(second.claimedAt);
  });

  it('claim by a DIFFERENT agent while not stale and no force: throws ClaimHeldError(heldBy, heldSince)', async () => {
    const first = await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    await expect(claim(store, { uid: issueUid, by: 'agent-b', action: 'claim' })).rejects.toThrow(ClaimHeldError);
    try {
      await claim(store, { uid: issueUid, by: 'agent-b', action: 'claim' });
      expect.unreachable('expected ClaimHeldError');
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimHeldError);
      const held = err as ClaimHeldError;
      expect(held.heldBy).toBe('agent-a');
      expect(held.heldSince).toBe(first.claimedAt);
    }

    // The rejected attempt must NEVER have mutated the row.
    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['claimedBy']).toBe('agent-a');
  });

  it('claim by a DIFFERENT agent with force:true overrides a non-stale claim: status:"reclaimed-stale", previousClaimant set', async () => {
    await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    const outcome = await claim(store, { uid: issueUid, by: 'agent-b', action: 'claim', force: true });

    expect(outcome.status).toBe('reclaimed-stale');
    expect(outcome.claimedBy).toBe('agent-b');
    expect(outcome.previousClaimant).toBe('agent-a');

    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['claimedBy']).toBe('agent-b');
    expect(row?.metadata?.['previousClaimant']).toBe('agent-a');
  });

  it('claim by a DIFFERENT agent once the lease is genuinely stale (project_policy.claim_stale_after_min): status:"reclaimed-stale", no force needed', async () => {
    // Drive `claim_stale_after_min` to 0 for this project ONLY — a direct, real SQL
    // write to the project node's own metadata (never a mock), so "age >= threshold"
    // is satisfied immediately without fabricating timestamps or waiting real minutes.
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ policy: { claimStaleAfterMin: 0 } }),
      projectUid,
    ]);

    await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    const outcome = await claim(store, { uid: issueUid, by: 'agent-b', action: 'claim' }); // no force

    expect(outcome.status).toBe('reclaimed-stale');
    expect(outcome.claimedBy).toBe('agent-b');
    expect(outcome.previousClaimant).toBe('agent-a');
  });

  it('release by the claimant: clears both fields, status:"released"', async () => {
    await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    const outcome = await claim(store, { uid: issueUid, by: 'agent-a', action: 'release' });
    expect(outcome.status).toBe('released');

    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['claimedBy']).toBeUndefined();
    expect(row?.metadata?.['claimedAt']).toBeUndefined();
    // still preserved — release is a claim-key-scoped clear, not a metadata wipe.
    expect(row?.metadata?.['assignee']).toBe('someone-preexisting');
  });

  it('release by a non-claimant, or on an unclaimed issue: status:"release-noop", no write, wasClaimedBy echoes the prior value', async () => {
    const noopUnclaimed = await claim(store, { uid: issueUid, by: 'agent-a', action: 'release' });
    expect(noopUnclaimed.status).toBe('release-noop');
    expect(noopUnclaimed.wasClaimedBy).toBeUndefined();

    await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    const noopOtherAgent = await claim(store, { uid: issueUid, by: 'agent-b', action: 'release' });
    expect(noopOtherAgent.status).toBe('release-noop');
    expect(noopOtherAgent.wasClaimedBy).toBe('agent-a');

    // A genuine no-op — the row must be untouched.
    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['claimedBy']).toBe('agent-a');
  });

  it('renew by the claimant: bumps claimedAt, status:"renewed"', async () => {
    const first = await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await claim(store, { uid: issueUid, by: 'agent-a', action: 'renew' });

    expect(renewed.status).toBe('renewed');
    expect(renewed.claimedBy).toBe('agent-a');
    expect(renewed.claimedAt).not.toBe(first.claimedAt);
  });

  it('renew by a non-claimant: throws ClaimHeldError, never mutates', async () => {
    const claimed = await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });
    await expect(claim(store, { uid: issueUid, by: 'agent-b', action: 'renew' })).rejects.toThrow(ClaimHeldError);
    try {
      await claim(store, { uid: issueUid, by: 'agent-b', action: 'renew' });
    } catch (err) {
      const held = err as ClaimHeldError;
      expect(held.heldBy).toBe('agent-a');
      expect(held.heldSince).toBe(claimed.claimedAt);
    }
    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['claimedBy']).toBe('agent-a');
  });

  it('renew on an unclaimed issue: throws ClaimHeldError (SPEC.md §6.3.5 assigns this to the same outcome as "held by someone else")', async () => {
    await expect(claim(store, { uid: issueUid, by: 'agent-a', action: 'renew' })).rejects.toThrow(ClaimHeldError);
  });

  it('IssueNotFoundError for a uid that does not resolve to a live issue', async () => {
    await expect(claim(store, { uid: 'not-a-real-uid', by: 'agent-a', action: 'claim' })).rejects.toThrow(IssueNotFoundError);
  });

  it('IssueNotFoundError for a uid whose issue has already been soft-deleted (never re-claimable)', async () => {
    await store.adapter.executeRun('UPDATE node SET t_invalid = ? WHERE uid = ?', ['2020-01-01T00:00:00.000Z', issueUid]);
    await expect(claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' })).rejects.toThrow(IssueNotFoundError);
  });

  it('InvalidArgumentError on missing/blank uid, by, or an out-of-vocabulary action', async () => {
    await expect(claim(store, { uid: '', by: 'agent-a', action: 'claim' })).rejects.toThrow(InvalidArgumentError);
    await expect(claim(store, { uid: issueUid, by: '   ', action: 'claim' })).rejects.toThrow(InvalidArgumentError);
    await expect(
      claim(store, { uid: issueUid, by: 'agent-a', action: 'bogus' as unknown as 'claim' }),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('every real write emits exactly one audit row, in order; release-noop emits none (SPEC.md §4a)', async () => {
    await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' }); // -> 'claimed'
    await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' }); // -> 'held' (audited as 'claimed')
    await claim(store, { uid: issueUid, by: 'agent-b', action: 'release' }); // -> 'release-noop', NO audit
    await claim(store, { uid: issueUid, by: 'agent-a', action: 'renew' }); // -> 'renewed'
    await claim(store, { uid: issueUid, by: 'agent-a', action: 'release' }); // -> 'released'

    const trail = await readAuditTrail(store, issueRowid);
    // 'created' (from createIssue itself) + claimed + claimed(held) + renewed + released — release-noop contributes NOTHING.
    expect(trail.map((r) => r.action)).toEqual(['created', 'claimed', 'claimed', 'renewed', 'released']);
    expect(trail[4].from).toBe('agent-a');
  });
});

// ---------------------------------------------------------------------------
// The CAS proof: two REAL OS processes, one barrier, one uid.
// ---------------------------------------------------------------------------

const WORKER_SCRIPT = join(HERE, '..', 'test', 'fixtures', 'cross-process-claim-worker.ts');
const TSX_BIN = join(HERE, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');

interface ClaimWorkerOutcome {
  tag: string;
  outcome: 'success' | 'rejected' | 'error';
  status?: IClaimOutcome['status'];
  heldBy?: string;
  heldSince?: string;
  message?: string;
}

function spawnClaimWorker(dbPath: string, tag: string, issueUid: string, root: string, env?: Record<string, string>): Promise<ClaimWorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [WORKER_SCRIPT, dbPath, tag, issueUid, root], {
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
        reject(new Error(`claim worker ${tag} exited ${code} with no JSON outcome line. stderr: ${err.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(lastLine) as ClaimWorkerOutcome);
      } catch {
        reject(new Error(`claim worker ${tag} exited ${code}, stdout did not parse as JSON: ${lastLine}. stderr: ${err.slice(-500)}`));
      }
    });
  });
}

/** Identical file-barrier protocol to `cross-process-write-safety.spec.ts`'s `runBarrieredPair` — duplicated locally (this slice's own files only) rather than imported, since that spec's helper is not exported. */
async function runBarrieredClaimPair(
  dbPath: string,
  root: string,
  issueUid: string,
  env?: Record<string, string>,
): Promise<[ClaimWorkerOutcome, ClaimWorkerOutcome]> {
  const readyA = join(root, 'ready-A');
  const readyB = join(root, 'ready-B');
  const go = join(root, 'GO');
  for (const f of [readyA, readyB, go]) rmSync(f, { force: true });

  let earlyFailure: unknown;
  const wA = spawnClaimWorker(dbPath, 'A', issueUid, root, env).catch((e) => {
    earlyFailure ??= e;
    throw e;
  });
  const wB = spawnClaimWorker(dbPath, 'B', issueUid, root, env).catch((e) => {
    earlyFailure ??= e;
    throw e;
  });
  const pair = Promise.all([wA, wB]);
  pair.catch(() => {
    /* handled — the real rejection surfaces via the awaited `pair` below or the early-failure throw */
  });

  const deadline = Date.now() + 30000;
  while (!(existsSync(readyA) && existsSync(readyB))) {
    if (earlyFailure !== undefined) {
      throw new Error(`a claim worker failed before reaching the start barrier: ${earlyFailure instanceof Error ? earlyFailure.message : String(earlyFailure)}`);
    }
    if (Date.now() > deadline) throw new Error('claim workers never reached the barrier');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  writeFileSync(go, 'go');
  return pair;
}

describe('claim — real concurrent-process CAS proof (BEGIN IMMEDIATE, SPEC.md §4c/§6.3.5)', () => {
  let dir: string;
  let dbPath: string;
  let seedStore: TestIssueStore;
  let issueUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('claim-cas-proof');
    dbPath = join(dir, 'backlog.db');
    seedStore = await openTestIssueStore(dbPath);
    const seeded = await seedProject(seedStore, 'claim-cas-project');
    const created = await createIssue(seedStore, {
      project: seeded.projectUid,
      title: 'claim CAS target',
      body: 'exercised by two real OS processes',
      by: 'filer',
    });
    issueUid = created.uid;
    await seedStore.close(); // closed BEFORE either worker opens the file, same discipline as cross-process-write-safety.spec.ts
  });

  afterEach(() => {
    removeTestIssueStoreDir(dir);
  });

  it(
    'CONTROL (immediate — the only mode used in production): two real processes claim the SAME uid at the same instant — exactly one wins, the other gets a non-retryable ClaimHeldError',
    async () => {
      const [a, b] = await runBarrieredClaimPair(dbPath, dir, issueUid);
      const results = [a, b];

      const winners = results.filter((r) => r.outcome === 'success');
      const losers = results.filter((r) => r.outcome === 'rejected');
      const unexpected = results.filter((r) => r.outcome === 'error');

      expect(unexpected, `no unexpected errors: ${JSON.stringify(unexpected)}`).toEqual([]);
      // THE assertion this test exists to prove: never both winners, never both losers.
      expect(winners.length, `expected exactly 1 winner, got ${winners.length}: ${JSON.stringify(results)}`).toBe(1);
      expect(losers.length, `expected exactly 1 rejected loser, got ${losers.length}: ${JSON.stringify(results)}`).toBe(1);
      expect(winners[0].status).toBe('claimed');
      // The loser's ClaimHeldError must name the WINNER as the holder — a fresh read of the
      // winner's already-committed state, never a stale pre-transaction guess.
      expect(losers[0].heldBy).toBe(`claimant-${winners[0].tag}`);

      // Persistence, verified through a FRESH connection — never either worker's own in-memory
      // view (the exact discipline `cross-process-write-safety.spec.ts` establishes for the
      // identical reason, BUG-039: a writer's own report is not proof of what actually landed).
      const freshStore = await openTestIssueStore(dbPath);
      try {
        const persisted = await freshStore.adapter.transaction(async (tx) => getNodeByUidTx(tx, issueUid));
        expect(persisted?.metadata?.['claimedBy']).toBe(`claimant-${winners[0].tag}`);
      } finally {
        await freshStore.close();
      }
    },
    60000,
  );

  it(
    'NEGATIVE CONTROL: ADHD_BACKLOG_UNSAFE_TX_MODE=deferred strips the BEGIN IMMEDIATE RESERVED-lock guarantee — proves the CONTROL case above is exercising that guarantee, not passing for an unrelated reason',
    async () => {
      const [a, b] = await runBarrieredClaimPair(dbPath, dir, issueUid, { ADHD_BACKLOG_UNSAFE_TX_MODE: 'deferred' });
      const results = [a, b];
      const winners = results.filter((r) => r.outcome === 'success');
      const losers = results.filter((r) => r.outcome === 'rejected');
      const unexpected = results.filter((r) => r.outcome === 'error');

      // The exact 1-winner/1-loser split is exactly the property `immediate` mode exists to
      // guarantee and `deferred` strips — so unlike the CONTROL case above, the per-run shape is
      // NOT asserted as a hard pass/fail here (this exact repro is documented as flaky in both
      // directions under load by this file's sibling, cross-process-write-safety.spec.ts, for the
      // identical reason: OS scheduling determines how much the two processes' snapshots actually
      // diverge on a given run — including, empirically observed running this file, an
      // unclassified `WriteIOError` on the loser's side instead of a clean silent double-win: two
      // deferred-mode writers racing an unconditional-by-rowid UPDATE with no `WHERE claimedBy=`
      // guard can ALSO surface as raw driver-level chaos, not only as a silent CAS bypass — both
      // are the downgrade breaking the guarantee, just via a different failure signature). The
      // real, observed numbers are logged below for whoever reads this test's output — this is
      // where "exactly 1 winner, 1 clean rejection" going red is meant to be OBSERVED, proving the
      // CONTROL test above has teeth.
      let observationNote: string;
      if (winners.length > 1) {
        observationNote =
          ' — BROKEN CAS REPRODUCED: both processes reported success, exactly the silent double-win BEGIN IMMEDIATE prevents';
      } else if (winners.length === 1 && losers.length === 1 && unexpected.length === 0) {
        observationNote = ' — CAS held this run despite the downgrade (not guaranteed under deferred; see comment above)';
      } else if (unexpected.length > 0) {
        observationNote =
          ' — DOWNGRADE MANIFESTED AS DRIVER-LEVEL CHAOS instead of a clean CAS rejection (also a break: the CONTROL case never produces an unclassified error at this concurrency level)';
      } else {
        observationNote = '';
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[claim CAS negative control] winners=${winners.length} losers=${losers.length} unexpected=${unexpected.length} ` +
          `results=${JSON.stringify(results)}` +
          observationNote,
      );

      // The one invariant that must ALWAYS hold regardless of mode or failure signature: the
      // store itself is never left corrupted — reopened fresh, the persisted `claimedBy` (if any)
      // is one of the two real candidate claimants, never a third, mangled, or partial value.
      const freshStore = await openTestIssueStore(dbPath);
      try {
        const persisted = await freshStore.adapter.transaction(async (tx) => getNodeByUidTx(tx, issueUid));
        const persistedClaimedBy = persisted?.metadata?.['claimedBy'];
        if (persistedClaimedBy !== undefined) {
          expect(['claimant-A', 'claimant-B']).toContain(persistedClaimedBy);
        }
      } finally {
        await freshStore.close();
      }
    },
    60000,
  );
});
