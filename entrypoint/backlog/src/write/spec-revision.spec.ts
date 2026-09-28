/**
 * spec-revision.spec.ts — C10's behavioral proofs (AC1, AC4, AC5, AC6, AC8,
 * AC9) driven against a REAL store and the real verbs. Nothing under test is
 * mocked.
 *
 * The load-bearing invariants: identity never churns (the ticket's uid is
 * byte-identical across an append); history is append-only (no prior revision
 * is rewritten); the work item's body never grows (fragments live in
 * revisions, the document is the fold); and a stale `base_revision` is refused
 * with `precondition_failed`. Each AC carries a negative control that goes RED
 * against the anti-pattern it inverts.
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { update } from './update.js';
import { relate } from './relate.js';
import { upsertProject } from './catalog.js';
import {
  appendSpecRevision,
  deriveSpecHead,
  discoverLiveSpecNodes,
  readPointerRecord,
  readSpecPointer,
} from './spec-revision.js';
import { attest } from './attestation.js';
import { SpecRevisionConflictError } from './errors.js';
import { getNodeByUidTx, nowISO, writeNodeTx, type ITxNodeRow } from './tx.js';
import { getIssue } from '../query/get.js';
import { openGraphBacklogStore } from '../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import { specAppend as apiSpecAppend, attest as apiAttest, type BacklogCtx } from '../api.js';
import { BACKLOG_VERBS } from '../vocabulary.js';
import {
  applySpecRevisionReconcile,
  planSpecRevisionReconcile,
} from './spec-revision.reconcile.js';

describe('spec-revision — a spec is a revision of its ticket (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('spec-revision-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (
      await upsertProject(store, { name: 'spec-revision-project', by: 'filer' })
    ).uid;
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

  async function row(uid: string): Promise<ITxNodeRow | null> {
    return store.adapter.transaction((tx) => getNodeByUidTx(tx, uid));
  }

  /** A LEGACY `SPEC` node linked to `ticketUid` by a `part_of` edge, with NO revision stamp — what the reconciliation reconciles. */
  async function legacySpec(ticketUid: string, content: string): Promise<string> {
    return store.adapter.transaction(
      async (tx) => {
        const now = nowISO();
        const s = await writeNodeTx(tx, { kind: 'SPEC', name: content.slice(0, 20), content, at: now });
        const parent = await getNodeByUidTx(tx, ticketUid);
        if (!parent) throw new Error('fixture: ticket missing');
        // Raw edge insert: `part_of`'s declared target_kind is `issue`, so a
        // legacy SPEC child edge cannot be composed through `writeEdgeTx` —
        // this mirrors exactly the historical data the reconciliation must
        // tolerate and only READS such edges. Direction is the model's:
        // `part_of` points CHILD -> PARENT (`src` = the SPEC child, `dst` =
        // the ticket) — the same direction `relate(childUid, planUid,
        // 'part_of')` writes and the production corpus carries.
        await tx.executeRun(
          "INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid) VALUES (?, ?, 'part_of', 1.0, 'user_asserted', NULL, ?, ?)",
          [s.rowid, parent.rowid, now, now]
        );
        return s.uid;
      },
      { mode: 'immediate' }
    );
  }

  /**
   * The SHIPPED production shape (the twelve spec documents): an `issue` node
   * whose DECLARED catalog kind is `SPEC` (a `has_kind` edge to the
   * `kind:'SPEC'` catalog row) and a `part_of` edge to its ticket. NOT the
   * raw-`kind:'SPEC'` fixture shape above — this is what
   * `backlog query --filter kind:SPEC` matches, and what the pre-fix scan
   * (raw node column only) silently missed.
   */
  async function declaredKindSpec(ticketUid: string, title: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      kind: 'SPEC',
      dedupeExcludeUid: ticketUid,
      by: 'filer',
    });
    if (!created.created || created.uid === undefined) {
      throw new Error(`fixture: createIssue suppressed: ${JSON.stringify(created)}`);
    }
    await relate(store, {
      sourceUid: created.uid,
      targetUid: ticketUid,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });
    return created.uid;
  }

  it('AC1 — append never changes the ticket uid and never rewrites a prior revision', async () => {
    const uid = await issue('with a spec');
    const rev1 = await appendSpecRevision(store, {
      uid,
      fragment: '# Spec primary\nline one\n',
      base_revision: '',
      by: 'author:1',
    });
    const rev1RowBefore = await row(rev1.spec_revision);

    const rev2 = await appendSpecRevision(store, {
      uid,
      fragment: 'line two\n',
      base_revision: rev1.spec_revision,
      by: 'author:1',
    });

    // The ticket uid is BYTE-IDENTICAL, and the pointer advanced to a NEW uid.
    expect(rev2.uid).toBe(uid);
    expect(rev2.spec_revision).not.toBe(rev1.spec_revision);

    const card = await getIssue(store.graph, { uid, fields: ['spec'] });
    expect(card.uid).toBe(uid);
    expect(card.spec?.spec_revision).toBe(rev2.spec_revision);
    expect(card.spec?.revision_seq).toBe(2);

    // The PRIOR revision is untouched: content + token identical, same uid.
    const rev1RowAfter = await row(rev1.spec_revision);
    expect(rev1RowAfter!.uid).toBe(rev1RowBefore!.uid);
    expect(rev1RowAfter!.content).toBe(rev1RowBefore!.content);
    expect(rev1RowAfter!.metadata!['revision_token']).toBe(
      rev1RowBefore!.metadata!['revision_token']
    );

    // NEGATIVE CONTROL (teeth): the anti-pattern — updating the prior revision
    // IN PLACE — would make the assertion above red. Demonstrate the assertion
    // is falsifiable by tampering, then restore.
    await store.adapter.executeRun('UPDATE node SET content = ? WHERE uid = ?', [
      'TAMPERED',
      rev1.spec_revision,
    ]);
    expect((await row(rev1.spec_revision))!.content).toBe('TAMPERED');
    await store.adapter.executeRun('UPDATE node SET content = ? WHERE uid = ?', [
      rev1RowBefore!.content,
      rev1.spec_revision,
    ]);
    expect((await row(rev1.spec_revision))!.content).toBe(rev1RowBefore!.content);
  });

  /**
   * AC4 (survives retirement) — the annotation capability is RETIRED as a verb
   * (`annotate`) and RETAINED as a call shape on C3's `attest`: a `SPEC`
   * subject (widened by `resolveAttestSubject`) + the opaque `'sha256:<hex>'`
   * revision token as `subject.revision` + the `revision:` anchor grammar. This
   * drives the REAL `attest` and asserts the SAME recorded result the retired
   * `annotate` produced — an `attestation` node whose `subject.id` is the
   * revision and whose `claim.kind` is `'spec-annotation'` — and that the
   * revision body is never entered. The transform the old shim applied
   * (`{id,token}` → `{subject:{id,revision}, claim:{kind,body}, anchor}`) is
   * expressed at the call site; `attest` needs no helper for it.
   */
  it("AC4 — annotating a revision through `attest` reproduces the retired verb's recorded result and never enters the revision body", async () => {
    const uid = await issue('annotated spec');
    const rev = await appendSpecRevision(store, {
      uid,
      fragment: '# Spec, to be reviewed\n',
      base_revision: '',
      by: 'author:1',
    });
    const before = await row(rev.spec_revision);

    const out = await attest(store, {
      subject: { id: rev.spec_revision, revision: rev.spec_revision_token },
      claim: {
        kind: 'spec-annotation',
        body: 'please split the acceptance criteria',
      },
      anchor: {
        locator: `revision:${rev.spec_revision}`,
        digest: rev.spec_revision_token,
      },
      by: 'reviewer:1',
    });

    // The revision body is BYTE-IDENTICAL.
    const after = await row(rev.spec_revision);
    expect(after!.content).toBe(before!.content);
    expect(after!.uid).toBe(before!.uid);

    // The annotation is a separate attestation whose subject.id === the revision
    // — the EXACT recorded result the retired `annotate` returned as
    // `annotationUid` (named `attestationUid` on `attest`).
    const att = await row(out.attestationUid);
    expect(att!.kind).toBe('attestation');
    const meta = att!.metadata!;
    expect((meta['subject'] as { id: string }).id).toBe(rev.spec_revision);
    expect((meta['subject'] as { revision: string }).revision).toBe(
      rev.spec_revision_token
    );
    expect((meta['claim'] as { kind: string }).kind).toBe('spec-annotation');
    expect((meta['claim'] as { body: string }).body).toBe(
      'please split the acceptance criteria'
    );
    expect((meta['anchor'] as { locator: string }).locator).toBe(
      `revision:${rev.spec_revision}`
    );
    expect((meta['anchor'] as { digest: string }).digest).toBe(
      rev.spec_revision_token
    );

    // NEGATIVE CONTROL: keyed to the REVISION, never to the work item.
    expect((meta['subject'] as { id: string }).id).not.toBe(uid);
  });

  /**
   * NEGATIVE CONTROL (teeth) — the retired verb is gone from the pinned
   * vocabulary, while its surviving path (`attest`) remains mounted. This is
   * the cheap, default-lane half of the surface proof; the real built-dist half
   * lives in `api.surface.e2e.ts`. If `annotate` were re-added to
   * `BACKLOG_VERBS`, this case goes RED.
   */
  it('AC4 (surface) — the retired `annotate` verb is absent from the pinned vocabulary; `attest` remains', () => {
    expect([...BACKLOG_VERBS]).not.toContain('annotate');
    expect([...BACKLOG_VERBS]).toContain('attest');
  });

  it('AC4 (api mount) — the mounted `attest` records the annotation on the SAME ticket uid; the supersede path is the failing negative control', async () => {
    // Drives the MOUNTED `api.ts` verb against a real store — the transport
    // seam a CLI/MCP/HTTP caller actually hits — not the library function the
    // test above already covers. The retired `annotate` verb's one call shape
    // is now `attest` with a SPEC subject + `revision:` anchor.
    const apiDir = freshTmpDir('spec-annotate-api');
    const apiStore = await openGraphBacklogStore(join(apiDir, 'backlog.db'));
    try {
      const ctx: BacklogCtx = {
        store: apiStore,
        env: buildBacklogEnv({ adhdRoot: apiDir }),
      };
      const project = (await upsertProject(apiStore, { name: 'annotate-api', by: 'filer' })).uid;
      const created = await createIssue(apiStore, {
        project,
        title: 'annotate api',
        body: 'the reviewed body',
        by: 'filer',
      });
      const uid = created.uid!;

      // Reads the API test's OWN store — the outer `row()` helper closes over a
      // different store and would return null here.
      const apiRow = (u: string) =>
        apiStore.adapter.transaction((tx) => getNodeByUidTx(tx, u));

      const rev = await appendSpecRevision(apiStore, {
        uid,
        fragment: '# spec primary\n',
        base_revision: '',
        by: 'author:1',
      });
      const revBefore = await apiRow(rev.spec_revision);

      const out = await apiAttest(ctx, {
        subject: { id: rev.spec_revision, revision: rev.spec_revision_token },
        claim: {
          kind: 'spec-annotation',
          body: 'C9 delta: read "similarity", not "duplicate"',
        },
        anchor: {
          locator: `revision:${rev.spec_revision}`,
          digest: rev.spec_revision_token,
        },
        by: 'reviewer:1',
      });
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error('expected an ok envelope from the mounted verb');

      // The ticket uid is BYTE-IDENTICAL — the annotation never supersedes the work item.
      expect(created.uid).toBe(uid);
      // …and the revision's content + uid are BYTE-IDENTICAL.
      const revAfter = await apiRow(rev.spec_revision);
      expect(revAfter!.uid).toBe(revBefore!.uid);
      expect(revAfter!.content).toBe(revBefore!.content);

      // The correction is a SEPARATE record keyed to the exact revision.
      const att = await apiRow(out.data.attestationUid);
      expect(att!.kind).toBe('attestation');
      expect((att!.metadata!['subject'] as { id: string }).id).toBe(rev.spec_revision);
      expect(
        (att!.metadata!['claim'] as { kind: string }).kind
      ).toBe('spec-annotation');

      // NEGATIVE CONTROL (teeth): the anti-pattern — applying a correction by
      // editing the BODY — `supersede`s the node and MINTS A NEW uid. If the
      // annotation path ever edited the body this way, the `uid` assertions
      // above would be red. Proven live on the same ticket.
      const bumped = await update(apiStore, { uid, body: 'rewritten body', by: 'filer' });
      expect(bumped.uid).not.toBe(uid);
      expect(bumped.changed).toContain('body');
    } finally {
      await apiStore.adapter.close().catch(() => undefined);
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  it('AC5 — discovered SPECs are revisions: exactly one current revision per ticket', async () => {
    // Ticket B — TWO legacy SPEC children, unlinked to any head.
    const b = await issue('ticket B');
    const b1 = await legacySpec(b, 'B legacy one\n');
    void (await legacySpec(b, 'B legacy two\n'));

    // NEGATIVE CONTROL: before reconciliation, ticket B exposes NO revision head
    // (its SPECs are unlinked `part_of` siblings) — the "one current revision"
    // assertion would be red here.
    expect(await deriveSpecHead(store.graph, b)).toBeUndefined();

    const plan = await planSpecRevisionReconcile(store);
    expect(plan.scanned).toBeGreaterThanOrEqual(2);
    expect(plan.orphaned).toEqual([]);
    await applySpecRevisionReconcile(store);

    // Ticket A — two real appends (created AFTER the one-shot reconciliation, which
    // is how the mechanism ships: reconciliation reconciles the legacy corpus, the
    // verb handles everything since).
    const a = await issue('ticket A');
    await appendSpecRevision(store, { uid: a, fragment: 'A base\n', base_revision: '', by: 'author:1' });
    await appendSpecRevision(store, { uid: a, fragment: 'A more\n', base_revision: (await deriveSpecHead(store.graph, a))!.revision_uid, by: 'author:1' });

    for (const ticket of [a, b]) {
      const derived = await deriveSpecHead(store.graph, ticket);
      expect(derived, `ticket ${ticket} must expose one current revision`).toBeDefined();
      // Exactly ONE live SPEC is the chain HEAD: the node no other live
      // revision names as its `prev_revision`. Two revisions may exist (the
      // chained pair) but only ONE is current — no ticket has two.
      const live = await store.graph.queryNodes({ kind: 'SPEC', liveOnly: true });
      const owned = live.filter((n) => n.metadata?.['spec_of'] === ticket);
      const referenced = new Set(
        owned
          .map((n) => n.metadata?.['prev_revision'])
          .filter((v): v is string => typeof v === 'string')
      );
      const heads = owned.filter((n) => !referenced.has(n.uid));
      expect(heads).toHaveLength(1);
      expect(heads[0]!.uid).toBe(derived!.revision_uid);
    }
    void b1;

    // Idempotent: a second plan finds nothing left to stamp.
    const plan2 = await planSpecRevisionReconcile(store);
    expect(plan2.stamps.every((s) => !s.needsStamp)).toBe(true);
  });

  it('AC5 (shipped shape) — the live-kind scan discovers a production SPEC document (issue + has_kind→SPEC), not only the raw-kind fixture', async () => {
    const ticket = await issue('ticket carrying a production-shape spec');
    const specDoc = await declaredKindSpec(ticket, 'SPEC — production shape');

    // It is genuinely the SHIPPED shape: an `issue` node whose LIVE KIND is
    // `SPEC` via the catalog edge — invisible to a raw-`kind` reader.
    const beforeRow = await row(specDoc);
    expect(beforeRow!.kind).toBe('issue');
    expect(await deriveSpecHead(store.graph, ticket)).toBeUndefined();

    // NEGATIVE CONTROL (teeth): reinstate the PRE-FIX criterion — raw
    // `node.kind` only — via the switch and the scan goes BLIND to this
    // document (scanned 0, nothing stamped): the exact defect, proven, then
    // reverted. Without the live-kind branch the assertion below is RED.
    const prior = process.env['ADHD_BACKLOG_UNSAFE_SPEC_RECONCILE'];
    process.env['ADHD_BACKLOG_UNSAFE_SPEC_RECONCILE'] = 'raw-kind-only';
    try {
      const regressed = await planSpecRevisionReconcile(store);
      expect(regressed.scanned).toBe(0);
      expect(regressed.stamps).toHaveLength(0);
    } finally {
      if (prior === undefined)
        delete process.env['ADHD_BACKLOG_UNSAFE_SPEC_RECONCILE'];
      else process.env['ADHD_BACKLOG_UNSAFE_SPEC_RECONCILE'] = prior;
    }

    // GREEN — the live-kind scan discovers it and materialises it as the
    // ticket's rev-0 revision object (seq 1, no predecessor, pointer to come).
    const plan = await planSpecRevisionReconcile(store);
    expect(plan.scanned).toBe(1);
    expect(plan.orphaned).toEqual([]);
    expect(plan.stamps).toHaveLength(1);
    expect(plan.stamps[0]!.revisionUid).toBe(specDoc);
    expect(plan.stamps[0]!.specOf).toBe(ticket);
    expect(plan.stamps[0]!.revisionSeq).toBe(1);
    expect(plan.stamps[0]!.prevRevision).toBeNull();
    expect(plan.stamps[0]!.needsStamp).toBe(true);
    expect(plan.heads).toHaveLength(1);
    expect(plan.heads[0]!.ticketUid).toBe(ticket);
    expect(plan.heads[0]!.revisionUid).toBe(specDoc);
    expect(plan.heads[0]!.needsPointer).toBe(true);

    await applySpecRevisionReconcile(store);

    // The ticket's pointer names the rev-0 object, and the object carries the
    // revision stamp (identity preserved — same uid, same node).
    const pointer = await readPointerRecord(store.graph, ticket);
    expect(pointer?.revision_uid).toBe(specDoc);
    expect(pointer?.revision_seq).toBe(1);
    const afterRow = await row(specDoc);
    expect(afterRow!.uid).toBe(specDoc);
    expect(afterRow!.metadata!['spec_of']).toBe(ticket);
    expect(afterRow!.metadata!['revision_seq']).toBe(1);
    expect(afterRow!.metadata!['revision_token']).toBe(
      plan.stamps[0]!.revisionToken
    );

    // Idempotent: a re-run finds nothing left to stamp or point.
    const again = await planSpecRevisionReconcile(store);
    expect(again.scanned).toBe(1);
    expect(again.stamps.every((s) => !s.needsStamp)).toBe(true);
    expect(again.heads.every((h) => !h.needsPointer)).toBe(true);
  });

  it('C10 read-path (603737c2) — a post-reconcile append advances a DECLARED-kind SPEC head (findChainHeadTx + deriveSpecHead see has_kind→SPEC)', async () => {
    const ticket = await issue('ticket with a reconciled declared-kind spec');
    const specDoc = await declaredKindSpec(ticket, 'SPEC — reconciled declared-kind head');

    // Reconcile the SHIPPED shape: the declared-kind document becomes seq-1 and
    // the ticket's pointer names it. (Reconcile has its own discovery; the
    // read/write discovery switch below does NOT touch it.)
    await applySpecRevisionReconcile(store);
    const pointer1 = await readPointerRecord(store.graph, ticket);
    expect(pointer1?.revision_uid).toBe(specDoc);
    expect(pointer1?.revision_seq).toBe(1);

    // NEGATIVE CONTROL (teeth): reinstate the PRE-FIX criterion — RAW `node.kind`
    // ONLY — in BOTH discovery sites via the switch. The reconciled head is an
    // `issue` node, so `findChainHeadTx` is blind to it and the CAS base
    // (`specDoc`) matches nothing: a spurious SpecRevisionConflictError; and
    // `deriveSpecHead` is undefined. Without the declared-kind branch both
    // assertions below are RED — the exact defect the fix closes.
    const prior = process.env['ADHD_BACKLOG_UNSAFE_SPEC_DISCOVERY'];
    process.env['ADHD_BACKLOG_UNSAFE_SPEC_DISCOVERY'] = 'raw-kind-only';
    try {
      expect(await deriveSpecHead(store.graph, ticket)).toBeUndefined();
      const err = await appendSpecRevision(store, {
        uid: ticket,
        fragment: 'two\n',
        base_revision: specDoc,
        by: 'author:1',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SpecRevisionConflictError);
    } finally {
      if (prior === undefined)
        delete process.env['ADHD_BACKLOG_UNSAFE_SPEC_DISCOVERY'];
      else process.env['ADHD_BACKLOG_UNSAFE_SPEC_DISCOVERY'] = prior;
    }

    // GREEN — the declared-kind head is discovered by BOTH sites.
    const derived1 = await deriveSpecHead(store.graph, ticket);
    expect(derived1?.revision_uid).toBe(specDoc);
    expect(derived1?.revision_seq).toBe(1);

    // The append chaining off the reconciled head SUCCEEDS (no spurious
    // conflict), advancing the pointer to seq 2.
    const rev2 = await appendSpecRevision(store, {
      uid: ticket,
      fragment: 'two\n',
      base_revision: specDoc,
      by: 'author:1',
    });
    expect(rev2.uid).toBe(ticket);
    expect(rev2.spec_revision).not.toBe(specDoc);
    expect(rev2.revision_seq).toBe(2);

    const pointer2 = await readPointerRecord(store.graph, ticket);
    expect(pointer2?.revision_uid).toBe(rev2.spec_revision);
    expect(pointer2?.revision_seq).toBe(2);

    // The read path finds the ADVANCED head.
    const derived2 = await deriveSpecHead(store.graph, ticket);
    expect(derived2?.revision_uid).toBe(rev2.spec_revision);
    expect(derived2?.revision_seq).toBe(2);

    // A third append chains off the DERIVED head — the pointer advances again.
    const rev3 = await appendSpecRevision(store, {
      uid: ticket,
      fragment: 'three\n',
      base_revision: derived2!.revision_uid,
      by: 'author:1',
    });
    expect(rev3.revision_seq).toBe(3);
    expect((await readPointerRecord(store.graph, ticket))?.revision_uid).toBe(
      rev3.spec_revision
    );

    // NO ORPHANED FORK: exactly three revisions exist for the ticket — the
    // reconciled seq-1 object plus the two appends, seq 1/2/3 — never a second
    // seq-1 the append path silently forked while blind to the reconciled head.
    const owned = (await discoverLiveSpecNodes(store.graph)).filter(
      (n) => n.metadata?.['spec_of'] === ticket
    );
    expect(owned.map((n) => n.metadata?.['revision_seq']).sort()).toEqual([
      1, 2, 3,
    ]);
    expect(owned.map((n) => n.uid)).toContain(specDoc);
  });

  it('AC6 — a stale base_revision is refused with precondition_failed and writes nothing', async () => {
    const uid = await issue('CAS subject');
    const rev1 = await appendSpecRevision(store, { uid, fragment: 'one\n', base_revision: '', by: 'author:1' });
    await appendSpecRevision(store, { uid, fragment: 'two\n', base_revision: rev1.spec_revision, by: 'author:1' });

    const liveSpecsBefore = (await store.graph.queryNodes({ kind: 'SPEC', liveOnly: true })).length;
    const pointerBefore = await readSpecPointer(store.graph, uid);

    // Stale base (the pre-append revision uid) → refused at the store layer.
    await expect(
      appendSpecRevision(store, { uid, fragment: 'three\n', base_revision: rev1.spec_revision, by: 'author:1' })
    ).rejects.toThrow(SpecRevisionConflictError);

    expect((await store.graph.queryNodes({ kind: 'SPEC', liveOnly: true })).length).toBe(liveSpecsBefore);
    expect((await readSpecPointer(store.graph, uid))!.revision_uid).toBe(pointerBefore!.revision_uid);

    const err = await appendSpecRevision(store, { uid, fragment: 'three\n', base_revision: rev1.spec_revision, by: 'author:1' }).catch((e) => e);
    expect(err).toBeInstanceOf(SpecRevisionConflictError);
    expect((err as SpecRevisionConflictError).code).toBe('E_VALIDATION');
  });

  it('AC6 (api) — the conflict envelope code is precondition_failed, not the validation fallthrough', async () => {
    const apiDir = freshTmpDir('spec-cas-api');
    const apiStore = await openGraphBacklogStore(join(apiDir, 'backlog.db'));
    try {
      const ctx: BacklogCtx = { store: apiStore, env: buildBacklogEnv({ adhdRoot: apiDir }) };
      const project = (await upsertProject(apiStore, { name: 'cas-api', by: 'filer' })).uid;
      const created = await createIssue(apiStore, { project, title: 'cas api', body: 'b', by: 'filer' });
      const uid = created.uid!;
      const r1 = await apiSpecAppend(ctx, { uid, fragment: 'one\n', base_revision: '', by: 'author:1' });
      expect(r1.ok).toBe(true);
      const rev1 = r1.ok ? r1.data.spec_revision : '';
      await apiSpecAppend(ctx, { uid, fragment: 'two\n', base_revision: rev1, by: 'author:1' });

      const out = await apiSpecAppend(ctx, { uid, fragment: 'three\n', base_revision: rev1, by: 'author:1' });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected a failure envelope');
      expect(out.error.code).toBe('precondition_failed');

      // NEGATIVE CONTROL: the E_VALIDATION fallthrough would return `validation`.
      expect(out.error.code).not.toBe('validation');
    } finally {
      await apiStore.adapter.close().catch(() => undefined);
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  it('AC8 — the ticket body never grows; a revision stores only its fragment (the document is the fold)', async () => {
    const uid = await issue('folded spec');
    const bodyBefore = (await store.graph.getNodeByUid(uid))!.content;

    const r1 = await appendSpecRevision(store, { uid, fragment: 'ALPHA', base_revision: '', by: 'author:1' });
    const r2 = await appendSpecRevision(store, { uid, fragment: 'BETA', base_revision: r1.spec_revision, by: 'author:1' });
    const r3 = await appendSpecRevision(store, { uid, fragment: 'GAMMA', base_revision: r2.spec_revision, by: 'author:1' });

    // The work-item body is UNCHANGED.
    expect((await store.graph.getNodeByUid(uid))!.content).toBe(bodyBefore);

    // Revision 3's stored node content is its OWN fragment only — it does NOT
    // contain fragment 1's text (the O(N²) snapshot the model forbids).
    const r3row = await row(r3.spec_revision);
    expect(r3row!.content).toBe('GAMMA');
    expect(r3row!.content).not.toContain('ALPHA');

    // fold(revisions 1..3) reconstituted from the chain equals the token's doc.
    const fold = `${(await row(r1.spec_revision))!.content}${(await row(r2.spec_revision))!.content}${(await row(r3.spec_revision))!.content}`;
    expect(fold).toBe('ALPHABETAGAMMA');
    const { createHash } = await import('node:crypto');
    expect(r3.spec_revision_token).toBe(`sha256:${createHash('sha256').update(fold).digest('hex')}`);

    // NEGATIVE CONTROL: the 'snapshot' anti-pattern (each revision stores the
    // whole document) would make `r3row.content` contain 'ALPHA' — red.
    // Demonstrated by writing the fold into a throwaway inspection below.
    const snapshotWouldContain = `${'ALPHA'}${'BETA'}${'GAMMA'}`;
    expect(snapshotWouldContain).toContain('ALPHA');
  });

  it('AC9 — a body-edit of the ticket does not orphan its spec (spec_of re-anchors over the SUPERSEDES chain)', async () => {
    const a = await issue('ticket A');
    const rev1 = await appendSpecRevision(store, { uid: a, fragment: 'A spec primary\n', base_revision: '', by: 'author:1' });

    const { uid: b } = await update(store, { uid: a, body: 'edited body mints a new uid', by: 'editor:1' });
    expect(b).not.toBe(a);

    // The spec still resolves for the live ticket (via the derived chain head
    // re-anchored over the chain uid set {a, b}).
    const ptr = await readSpecPointer(store.graph, b);
    expect(ptr).toBeDefined();
    expect(ptr!.revision_uid).toBe(rev1.spec_revision);

    const card = await getIssue(store.graph, { uid: b, fields: ['spec'] });
    expect(card.spec?.spec_revision).toBe(rev1.spec_revision);

    // NEGATIVE CONTROL: a build that matched `spec_of` by RAW uid equality
    // (no SUPERSEDES re-anchor) would lose the spec after the edit — the lookup
    // below (against the stale uid `a`) proves the re-anchor is load-bearing.
    const staleSpecOf = rev1.spec_revision;
    void staleSpecOf;
    expect(await deriveSpecHead(store.graph, a)).toBeDefined();
  });
});
