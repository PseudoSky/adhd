/**
 * obligation.spec.ts — C4's behavioral proofs (AC1–AC6) driven against a REAL
 * store, a REAL git work tree, and the real `obligate`/`unobligate` verbs,
 * `assertValidPredicate` and `evaluatePredicate`. The thing under test is C4's
 * code; nothing is mocked.
 *
 * ## Resolvers (C4 does not ship one)
 *
 * `evaluatePredicate` is a pure walk over an injected `IPredicateResolver` —
 * C5 ships the tx-backed resolver, C6 the verdict resolver (see
 * `C5-closure-gate.spec.md`). C4's own leaf-semantics proofs (AC2, AC4)
 * therefore supply a **store-backed resolver** here, implementing the EXACT
 * leaf semantics C4 fixes and C5/C6 will implement: `evidence` counts DISTINCT
 * `verified` attestations of a kind, `blockers_terminal` treats a missing
 * status as non-terminal. AC3 (pure boolean composition) uses a trivial stub.
 *
 * ## Negative controls
 *
 * Every AC's negative control is demonstrated by a temporary local revert of
 * the code path that enforces it, then restored exactly. To make those reverts
 * one-line, the two store-backed resolver knobs (`countUnverified`,
 * `missingStatusTerminal`) are explicit options on the resolver factory — their
 * defaults are the MANUFACTURING-CORRECT semantics; flipping one reproduces
 * the documented defect and must turn the corresponding AC red.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import {
  freshTmpDir,
  openTmpStore,
  type TmpStore,
} from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { transition } from './transition.js';
import { attest } from './attestation.js';
import {
  assertValidPredicate,
  evaluatePredicate,
  obligate,
  unobligate,
  type IPredicate,
  type IPredicateResolver,
} from './obligation.js';
import {
  InvalidArgumentError,
  InvalidPredicateError,
  ObligationNotFoundError,
} from './errors.js';
import { getNodeByUidTx, nowISO, writeNodeTx, type ITxNodeRow } from './tx.js';
import { relate } from './relate.js';
import { getIssue } from '../query/get.js';
import { buildBacklogEnv } from '../env.js';
import {
  create,
  obligate as apiObligate,
  unobligate as apiUnobligate,
  upsertProject,
  type BacklogCtx,
} from '../api.js';

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

/** A store-backed resolver implementing C4's fixed leaf semantics (the shape C5/C6 will use). */
interface IResolverOpts {
  /** DEFECT INJECTION (AC2 negative control): count every attestation, ignoring `check.state`. */
  countUnverified?: boolean;
  /** DEFECT INJECTION (AC4 negative control): treat a blocker with no status as terminal. */
  missingStatusTerminal?: boolean;
}

describe('obligation — obligate/unobligate + the closed predicate core (real store)', () => {
  let dir: string;
  let repo: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('obligation-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'obligation test']);
    projectUid = (
      await seedProject(store, 'obligation-project')
    ).projectUid;
    // Give the project a filesystem path so attest's git ladder can resolve it.
    await store.adapter.executeRun(
      'UPDATE node SET meta = ? WHERE uid = ?',
      [JSON.stringify({ path: repo }), projectUid]
    );
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function issue(title: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (!created.created || created.uid === undefined) {
      throw new Error(`fixture: createIssue suppressed: ${JSON.stringify(created)}`);
    }
    return created.uid;
  }

  async function readRow(uid: string): Promise<ITxNodeRow | null> {
    return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
  }

  async function rowidOf(uid: string): Promise<number> {
    const row = await store.adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE uid = ?',
      [uid]
    );
    if (!row) throw new Error(`fixture: no node for uid ${uid}`);
    return row.rowid;
  }

  function commit(rel: string, content: string): void {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
    git(repo, ['add', rel]);
    git(repo, ['commit', '-qm', `add ${rel}`]);
  }

  /** A store-backed resolver — the C5/C6 leaf semantics, defect-injectable for the negative controls. */
  function resolverFor(
    issueRowid: number,
    opts: IResolverOpts = {}
  ): IPredicateResolver {
    const verifyClause = opts.countUnverified
      ? ''
      : "AND json_extract(n.meta,'$.check.state') = 'verified'";
    return {
      async countVerifiedAttestations(kind: string): Promise<number> {
        const row = await store.adapter.executeGet<{ n: number }>(
          `SELECT COUNT(DISTINCT n.uid) AS n
             FROM edge e JOIN node n ON n.rowid = e.dst
            WHERE e.src = ? AND e.rel = 'attests' AND e.t_invalid IS NULL
              AND n.kind = 'attestation' AND n.t_invalid IS NULL
              AND json_extract(n.meta,'$.claim.kind') = ?
              ${verifyClause}`,
          [issueRowid, kind]
        );
        return row?.n ?? 0;
      },
      async blockersAllTerminal(): Promise<boolean> {
        const incoming = await store.adapter.executeAll<{ src: number }>(
          "SELECT src FROM edge WHERE dst = ? AND rel = 'blocks' AND t_invalid IS NULL",
          [issueRowid]
        );
        for (const { src } of incoming.rows) {
          const status = await store.adapter.executeGet<{ meta: string | null }>(
            `SELECT s.meta AS meta FROM edge se JOIN node s ON s.rowid = se.dst
              WHERE se.src = ? AND se.rel = 'has_status' AND se.t_invalid IS NULL
              LIMIT 1`,
            [src]
          );
          let terminal: boolean;
          if (!status) {
            terminal = opts.missingStatusTerminal ?? false;
          } else {
            let meta: Record<string, unknown> = {};
            try {
              meta = status.meta ? (JSON.parse(status.meta) as Record<string, unknown>) : {};
            } catch {
              meta = {};
            }
            terminal = meta['terminal'] === true;
          }
          if (!terminal) return false;
        }
        return true;
      },
      async relationExists(type: string, direction: 'in' | 'out'): Promise<boolean> {
        const sql =
          direction === 'in'
            ? "SELECT 1 AS x FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL LIMIT 1"
            : "SELECT 1 AS x FROM edge WHERE src = ? AND rel = ? AND t_invalid IS NULL LIMIT 1";
        const row = await store.adapter.executeGet<{ x: number }>(sql, [issueRowid, type]);
        return row !== null && row !== undefined;
      },
    };
  }

  // -------------------------------------------------------------------------
  // AC1 — one obligation of each core predicate kind; get returns them;
  //       unobligate removes one.
  // -------------------------------------------------------------------------
  it('AC1 — obligate stores one obligation of each core kind; get returns them; unobligate retires one', async () => {
    const uid = await issue('all-kinds subject');
    const before = await readRow(uid);

    const predicates: IPredicate[] = [
      { op: 'evidence', kind: 'published-artifact', min: 1 },
      { op: 'blockers_terminal' },
      { op: 'relation', type: 'relates_to', direction: 'in' },
      { op: 'all_of', of: [{ op: 'relation', type: 'blocks', direction: 'out' }] },
      { op: 'any_of', of: [{ op: 'blockers_terminal' }, { op: 'relation', type: 'blocks', direction: 'in' }] },
      { op: 'not', of: { op: 'relation', type: 'duplicate_of', direction: 'in' } },
    ];

    const uids: string[] = [];
    for (const requirement of predicates) {
      const out = await obligate(store, {
        uid,
        applies_to: { to: 'RESOLVED' },
        requirement,
        on_fail: 'block',
        by: 'declarer:1',
      });
      expect(out.uid).toBe(uid);
      uids.push(out.obligationUid);
    }

    // The subject issue is byte-for-byte untouched — obligate writes only the
    // obligation node + edge + audit; nothing is stored on the issue.
    const after = await readRow(uid);
    expect(after!.rowid).toBe(before!.rowid);
    expect(after!.metadata).toEqual(before!.metadata);
    expect(after!.tInvalid).toBe(before!.tInvalid);

    const card = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(card.obligations).toHaveLength(6);
    expect(card.obligations!.map((o) => o.requirement.op).sort()).toEqual(
      ['all_of', 'any_of', 'blockers_terminal', 'evidence', 'not', 'relation'].sort()
    );
    for (const o of card.obligations!) {
      expect(o.applies_to.to).toBe('RESOLVED');
      expect(o.on_fail).toBe('block');
    }

    // Retire one — it disappears from the next read and its node is soft-invalidated.
    const retired = uids[0]!;
    const out = await unobligate(store, { obligationUid: retired, by: 'declarer:1' });
    expect(out.invalidated).toBe(true);

    const card2 = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(card2.obligations).toHaveLength(5);
    expect(card2.obligations!.some((o) => o.uid === retired)).toBe(false);
    const retiredRow = await readRow(retired);
    expect(retiredRow!.tInvalid).not.toBeNull();
    expect(retiredRow!.metadata?.['invalidatedReason']).toBe('unobligated');
  });

  // -------------------------------------------------------------------------
  // AC2 — evidence{kind,min} counts DISTINCT VERIFIED attestations.
  // -------------------------------------------------------------------------
  it('AC2 — evidence.min counts distinct verified attestations; unverified never counts', async () => {
    const uid = await issue('evidence subject');
    const rowid = await rowidOf(uid);
    commit('artifact.txt', 'content-alpha');

    const pred: IPredicate = { op: 'evidence', kind: 'published-artifact', min: 2 };
    const resolver = resolverFor(rowid);

    // Zero verified → unsatisfied.
    expect(await evaluatePredicate(pred, resolver)).toBe(false);

    // One verified → still unsatisfied (min 2).
    await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:artifact.txt', digest: sha256('content-alpha') },
      by: 'attester:1',
    });
    expect(await evaluatePredicate(pred, resolver)).toBe(false);

    // One verified + one UNVERIFIED → STILL unsatisfied: unverified does not count.
    await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'url:https://example.test/x', digest: sha256('x') },
      by: 'attester:1',
    });
    expect(await evaluatePredicate(pred, resolver)).toBe(false);

    // A second VERIFIED attestation → satisfied (min 2 reached by two distinct verified).
    commit('artifact2.txt', 'content-beta');
    await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:artifact2.txt', digest: sha256('content-beta') },
      by: 'attester:1',
    });
    expect(await evaluatePredicate(pred, resolver)).toBe(true);

    // Omitted `min` ⇒ >= 1.
    expect(
      await evaluatePredicate({ op: 'evidence', kind: 'published-artifact' }, resolver)
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC3 — boolean composition (pure; stub resolver).
  // -------------------------------------------------------------------------
  it('AC3 — all_of/any_of/not across every leaf-value combination + the empty-set identities', async () => {
    const leaf = (t: string): IPredicate => ({ op: 'relation', type: t, direction: 'in' });
    const stub = (a: boolean, b: boolean): IPredicateResolver => ({
      async countVerifiedAttestations() {
        return 0;
      },
      async blockersAllTerminal() {
        return false;
      },
      async relationExists(type: string) {
        return type === 'a' ? a : b;
      },
    });

    const combos: Array<[boolean, boolean]> = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    for (const [a, b] of combos) {
      const r = stub(a, b);
      const allOf: IPredicate = { op: 'all_of', of: [leaf('a'), leaf('b')] };
      const anyOf: IPredicate = { op: 'any_of', of: [leaf('a'), leaf('b')] };
      expect(await evaluatePredicate(allOf, r)).toBe(a && b);
      expect(await evaluatePredicate(anyOf, r)).toBe(a || b);
      expect(await evaluatePredicate({ op: 'not', of: allOf }, r)).toBe(!(a && b));
      expect(await evaluatePredicate({ op: 'not', of: anyOf }, r)).toBe(!(a || b));
    }

    // Documented short-circuits.
    const r = stub(false, false);
    expect(await evaluatePredicate({ op: 'all_of', of: [] }, r)).toBe(true);
    expect(await evaluatePredicate({ op: 'any_of', of: [] }, r)).toBe(false);
    expect(await evaluatePredicate({ op: 'not', of: { op: 'any_of', of: [] } }, r)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC4 — blockers_terminal() in both directions; no write to the dependent.
  // -------------------------------------------------------------------------
  it('AC4 — blockers_terminal() is false for a non-terminal blocker, true once terminal; the dependent is never written', async () => {
    const dependent = await issue('blocked dependent');
    const depRowBefore = await readRow(dependent);
    const depRowid = await rowidOf(dependent);

    // Blocker A: a raw `issue` node with NO has_status edge (missing status ⇒ non-terminal).
    const blockerNoStatus = await store.adapter.transaction(
      async (tx) =>
        (
          await writeNodeTx(tx, {
            kind: 'issue',
            name: 'blocker (statusless)',
            content: 'x',
            metadata: {},
            at: nowISO(),
          })
        ).uid,
      { mode: 'immediate' }
    );
    await relate(store, {
      sourceUid: blockerNoStatus,
      targetUid: dependent,
      rel: 'blocks',
      action: 'add',
      by: 'relater:1',
    });

    const resolver = resolverFor(depRowid);
    const pred: IPredicate = { op: 'blockers_terminal' };
    // A statusless blocker is non-terminal (fail-closed) → unsatisfied.
    expect(await evaluatePredicate(pred, resolver)).toBe(false);

    // Blocker B: a normal issue, open → non-terminal.
    const blocker = await issue('blocker (open)');
    await relate(store, {
      sourceUid: blocker,
      targetUid: dependent,
      rel: 'blocks',
      action: 'add',
      by: 'relater:1',
    });
    expect(await evaluatePredicate(pred, resolver)).toBe(false);

    // Transition blocker B to a terminal status → that one is cleared, but the
    // statusless blocker still holds the overall predicate unsatisfied.
    await seedTerminalStatus(store, 'done');
    await transition(store, {
      uid: blocker,
      by: 'closer:1',
      toStatus: 'done',
      note: 'shipped',
    });
    expect(await evaluatePredicate(pred, resolver)).toBe(false);

    // Retire the statusless blocker's edge → now every remaining blocker is terminal.
    await relate(store, {
      sourceUid: blockerNoStatus,
      targetUid: dependent,
      rel: 'blocks',
      action: 'remove',
      by: 'relater:1',
    });
    expect(await evaluatePredicate(pred, resolver)).toBe(true);

    // The dependent was NEVER written by any of the above.
    const depRowAfter = await readRow(dependent);
    expect(depRowAfter!.rowid).toBe(depRowBefore!.rowid);
    expect(depRowAfter!.metadata).toEqual(depRowBefore!.metadata);
    expect(depRowAfter!.tInvalid).toBe(depRowBefore!.tInvalid);
  });

  // -------------------------------------------------------------------------
  // AC5 — the declared severity is stored and returned verbatim.
  // -------------------------------------------------------------------------
  it('AC5 — on_fail (warn|block) is stored and returned verbatim by the read projection', async () => {
    const uid = await issue('severity subject');
    await obligate(store, {
      uid,
      applies_to: { from: 'open', to: 'RESOLVED' },
      requirement: { op: 'blockers_terminal' },
      on_fail: 'warn',
      by: 'declarer:1',
    });
    await obligate(store, {
      uid,
      applies_to: { to: '*' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      override: { actors: ['dispatcher:1'] },
      by: 'declarer:1',
    });

    const card = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(card.obligations).toHaveLength(2);
    const byOp = new Map(card.obligations!.map((o) => [o.requirement.op, o]));
    expect(byOp.get('blockers_terminal')!.on_fail).toBe('warn');
    expect(byOp.get('evidence')!.on_fail).toBe('block');
    // applies_to + override round-trip verbatim.
    expect(byOp.get('blockers_terminal')!.applies_to).toEqual({
      from: 'open',
      to: 'RESOLVED',
    });
    expect(byOp.get('evidence')!.applies_to).toEqual({ to: '*' });
    expect(byOp.get('evidence')!.override).toEqual({ actors: ['dispatcher:1'] });
  });

  // -------------------------------------------------------------------------
  // AC6 — additive floor: an obligation-free item still reads and transitions.
  // -------------------------------------------------------------------------
  it('AC6 — an obligation-free item reads and transitions exactly as before (create → get → transition)', async () => {
    const uid = await issue('obligation-free item');

    // Reads: the default card omits `obligations`; an explicit request returns [].
    const defaultCard = await getIssue(store.graph, { uid });
    expect('obligations' in defaultCard).toBe(false);
    const withField = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(withField.obligations).toEqual([]);

    // Transitions: the full path runs with zero obligations — obligate is never
    // required for any existing verb to function.
    await seedTerminalStatus(store, 'done');
    const outcome = await transition(store, {
      uid,
      by: 'closer:1',
      toStatus: 'done',
      note: 'no obligation needed',
    });
    expect(outcome.toStatus).toBe('done');
  });

  // -------------------------------------------------------------------------
  // Validation: the closed core + a required applies_to.to.
  // -------------------------------------------------------------------------
  it('rejects an unknown predicate op, a bad leaf, and evidence.min<1 with InvalidPredicateError (nothing written)', async () => {
    const uid = await issue('validation subject');
    const cases: unknown[] = [
      { op: 'cel', expr: 'x > 1' },
      { op: 'evidence' },
      { op: 'evidence', kind: '   ' },
      { op: 'evidence', kind: 'x', min: 0 },
      { op: 'relation', type: 'r', direction: 'sideways' },
      { op: 'all_of', of: 'not-an-array' },
      { op: 'all_of', of: [{ op: 'nope' }] },
      { op: 'not', of: [] },
      { op: 'evidence', kind: 'x', extra: true },
    ];
    for (const requirement of cases) {
      await expect(
        obligate(store, {
          uid,
          applies_to: { to: 'RESOLVED' },
          requirement: requirement as IPredicate,
          on_fail: 'block',
          by: 'declarer:1',
        })
      ).rejects.toThrow(InvalidPredicateError);
    }
    // `assertValidPredicate` is exported and synchronous.
    expect(() => assertValidPredicate({ op: 'cel' })).toThrow(InvalidPredicateError);

    // Nothing was written.
    const card = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(card.obligations).toEqual([]);
  });

  it('rejects an omitted/blank applies_to.to and a bad on_fail with InvalidArgumentError', async () => {
    const uid = await issue('applies-to subject');
    await expect(
      obligate(store, {
        uid,
        // applies_to.to omitted entirely
        applies_to: {} as never,
        requirement: { op: 'blockers_terminal' },
        on_fail: 'block',
        by: 'declarer:1',
      })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      obligate(store, {
        uid,
        applies_to: { to: '   ' },
        requirement: { op: 'blockers_terminal' },
        on_fail: 'block',
        by: 'declarer:1',
      })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      obligate(store, {
        uid,
        applies_to: { to: 'RESOLVED' },
        requirement: { op: 'blockers_terminal' },
        on_fail: 'maybe' as never,
        by: 'declarer:1',
      })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('unobligate on an unknown uid throws ObligationNotFoundError (nothing written)', async () => {
    await expect(
      unobligate(store, {
        obligationUid: '00000000-0000-4000-8000-000000000000',
        by: 'declarer:1',
      })
    ).rejects.toThrow(ObligationNotFoundError);
  });
});

/** Seeds a `status` catalog row with `terminal:true` directly (a reserved-name seed would also default it, but this is explicit). */
async function seedTerminalStatus(store: TestIssueStore, name: string): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      await writeNodeTx(tx, {
        kind: 'status',
        name,
        metadata: { terminal: true },
        at: nowISO(),
      });
    },
    { mode: 'immediate' }
  );
}

describe('C4 — mounted api surface maps the new error classes + envelope code', () => {
  let tmp: TmpStore;
  let ctx: BacklogCtx;
  let issueUid: string;

  beforeEach(async () => {
    tmp = await openTmpStore('c4-api-surface');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const project = await upsertProject(ctx, { name: 'c4-api-surface-project', by: 'filer' });
    if (!project.ok) throw new Error('fixture: upsertProject failed');
    const created = await create(ctx, {
      project: project.data.uid,
      title: 'api surface issue',
      body: 'b',
      by: 'filer',
    });
    if (!created.ok || created.data.uid === undefined) {
      throw new Error('fixture: create failed');
    }
    issueUid = created.data.uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('an unknown predicate op maps to invalid_argument (CEL is out of the closed core)', async () => {
    const out = await apiObligate(ctx, {
      uid: issueUid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'cel', expr: 'x > 1' } as never,
      on_fail: 'block',
      by: 'declarer:1',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('invalid_argument');
  });

  it('an omitted applies_to.to maps to invalid_argument', async () => {
    const out = await apiObligate(ctx, {
      uid: issueUid,
      applies_to: {} as never,
      requirement: { op: 'blockers_terminal' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('invalid_argument');
  });

  it('ObligationNotFoundError maps to item_not_found (distinct from the validation fallback)', async () => {
    const out = await apiUnobligate(ctx, {
      obligationUid: '00000000-0000-4000-8000-000000000000',
      by: 'declarer:1',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('item_not_found');
  });

  it('the happy path mounts: obligate → ok envelope with an obligationUid', async () => {
    const out = await apiObligate(ctx, {
      uid: issueUid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact', min: 1 },
      on_fail: 'block',
      by: 'declarer:1',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('expected a success envelope');
    expect(typeof out.data.obligationUid).toBe('string');
  });
});
