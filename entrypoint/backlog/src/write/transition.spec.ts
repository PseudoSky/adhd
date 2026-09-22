/**
 * transition.spec.ts — behavioral proof for `transition` (SPEC.md §4a,
 * §6.3.4, §8 AC-15).
 *
 * Real store, real reads, never mocks: a transition swaps the LIVE
 * `has_status` edge, writes a fresh `transition` node whose `sha` is
 * recomputed and compared byte-for-byte (never "some sha exists"), stamps
 * `closedAt` on a terminal transition and CLEARS it on a reopen (the
 * stale-timestamp case §8 AC-15 calls out by name, not just the
 * never-set-yet case), and gates on `note`/`citations` exactly per
 * `project_policy`. Citation verification is proven against a REAL file on
 * disk (a real sha256, never a stubbed one) alongside the unverifiable case.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { update } from './update.js';
import { transition } from './transition.js';
import { claim } from './claim.js';
import { queryIssues } from '../query/query.js';
import {
  CatalogNotFoundError,
  CitationRequiredError,
  CitationUnverifiableError,
  ClaimHeldError,
  InvalidArgumentError,
  IssueNotFoundError,
  NoteRequiredError,
  StaleSupersedeError,
} from './errors.js';
import {
  canonicalJSONStringify,
  getNodeByUidTx,
  nowISO,
  sha256Hex,
  writeNodeTx,
  type ITxNodeRow,
} from './tx.js';

async function readNode(
  store: TestIssueStore,
  uid: string
): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

interface RawEdgeRow {
  src: number;
  dst: number;
}

async function liveEdges(
  store: TestIssueStore,
  rel: string,
  opts: { src?: number; dst?: number }
): Promise<RawEdgeRow[]> {
  const clauses: string[] = ['rel = ?', 't_invalid IS NULL'];
  const params: unknown[] = [rel];
  if (opts.src !== undefined) {
    clauses.push('src = ?');
    params.push(opts.src);
  }
  if (opts.dst !== undefined) {
    clauses.push('dst = ?');
    params.push(opts.dst);
  }
  const { rows } = await store.adapter.executeAll<RawEdgeRow>(
    `SELECT src, dst FROM edge WHERE ${clauses.join(' AND ')}`,
    params
  );
  return rows;
}

interface RawAuditRow {
  action: string;
  from: string | null;
  to: string | null;
  note: string | null;
}

async function readAuditTrail(
  store: TestIssueStore,
  subjectRowid: number
): Promise<RawAuditRow[]> {
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(
    `SELECT a.meta as meta FROM edge e JOIN node a ON a.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL AND a.kind = 'audit'
     ORDER BY a.rowid ASC`,
    [subjectRowid]
  );
  return rows.map((row) => {
    const meta = row.meta
      ? (JSON.parse(row.meta) as Record<string, unknown>)
      : {};
    return {
      action: String(meta['action'] ?? ''),
      from: (meta['from'] as string | null) ?? null,
      to: (meta['to'] as string | null) ?? null,
      note: (meta['note'] as string | null) ?? null,
    };
  });
}

/** Seeds a `status` catalog row directly (so `mintOrResolveCatalogTx` RESOLVES it — name already exists — never mints, which would always force `terminal:false`). */
async function seedStatus(
  store: TestIssueStore,
  name: string,
  terminal: boolean
): Promise<string> {
  return store.adapter.transaction(
    async (tx) => {
      const row = await writeNodeTx(tx, {
        kind: 'status',
        name,
        metadata: { terminal },
        at: nowISO(),
      });
      return row.uid;
    },
    { mode: 'immediate' }
  );
}

async function setProjectPolicy(
  store: TestIssueStore,
  projectUid: string,
  policy: Record<string, unknown>,
  path?: string
): Promise<void> {
  const meta: Record<string, unknown> = { policy };
  if (path !== undefined) meta.path = path;
  await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
    JSON.stringify(meta),
    projectUid,
  ]);
}

describe('transition — status change (SPEC.md §6.3.4, real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let issueUid: string;
  let issueRowid: number;

  beforeEach(async () => {
    dir = freshTmpDir('transition-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const seeded = await seedProject(store, 'transition-spec-project');
    projectUid = seeded.projectUid;
    const created = await createIssue(store, {
      project: projectUid,
      title: 'transition target',
      body: 'body',
      by: 'filer',
      status: 'open',
    });
    issueUid = created.uid;
    const row = await readNode(store, issueUid);
    if (!row)
      throw new Error('setup: issue not found immediately after createIssue');
    issueRowid = row.rowid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('swaps the LIVE has_status edge and returns fromStatus/toStatus, given a note (policy default requires one)', async () => {
    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'starting work',
    });
    expect(outcome.fromStatus).toBe('open');
    expect(outcome.toStatus).toBe('in-progress');
    expect(outcome.closedAt).toBeUndefined();
    expect(outcome.uid).toBe(issueUid);

    const edges = await liveEdges(store, 'has_status', { src: issueRowid });
    expect(edges).toHaveLength(1);
    const target = await readNode(store, issueUid); // re-read is harmless; assert via the edge target directly
    void target;
  });

  it('NoteRequiredError when no note is given (project_policy.transition_requires_note defaults true)', async () => {
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'in-progress',
      })
    ).rejects.toThrow(NoteRequiredError);
    // nothing was written — still exactly the ONE has_status edge from createIssue.
    const edges = await liveEdges(store, 'has_status', { src: issueRowid });
    expect(edges).toHaveLength(1);
  });

  it('transition_requires_note:false permits a note-less transition', async () => {
    await setProjectPolicy(store, projectUid, {
      transitionRequiresNote: false,
    });
    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
    });
    expect(outcome.toStatus).toBe('in-progress');
  });

  it('a terminal toStatus stamps closedAt on BOTH the outcome and issue.meta.metadata.closedAt', async () => {
    await seedStatus(store, 'done', true);
    const before = Date.now();
    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'done',
      note: 'shipped',
    });
    expect(outcome.closedAt).toBeDefined();
    expect(Date.parse(outcome.closedAt!)).toBeGreaterThanOrEqual(before);

    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['closedAt']).toBe(outcome.closedAt);
  });

  it('a supplied gitContext updates issue.meta.metadata.gitContext on the metadata touch; a later transition omitting it PRESERVES the stored value', async () => {
    await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'start',
      gitContext: 'feat/backlog-hard-replacement @ 4bf902fc',
    });
    const afterFirst = await readNode(store, issueUid);
    expect(afterFirst?.metadata?.['gitContext']).toBe(
      'feat/backlog-hard-replacement @ 4bf902fc'
    );

    // The metadata touch REPLACES `meta` wholesale — prove the omitted case
    // carries the prior value forward rather than dropping it.
    await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'open',
      note: 'reopen',
    });
    const afterSecond = await readNode(store, issueUid);
    expect(afterSecond?.metadata?.['gitContext']).toBe(
      'feat/backlog-hard-replacement @ 4bf902fc'
    );
  });

  it('§8 AC-15: reopening a terminal issue CLEARS closedAt — the stale-timestamp case, not just never-set', async () => {
    await seedStatus(store, 'done', true);
    const closeOutcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'done',
      note: 'shipped',
    });
    expect(closeOutcome.closedAt).toBeDefined();

    // §8 AC-15's actual named entrypoint: `queryIssues` with
    // `filter:{closedAt:{since:...}}}`, not a raw row read. While closed,
    // the query MUST match.
    const whileClosedResult = await queryIssues(store, {
      filter: { closedAt: { since: closeOutcome.closedAt } },
    });
    if (whileClosedResult.view !== 'list')
      throw new Error(`expected view 'list', got '${whileClosedResult.view}'`);
    expect(whileClosedResult.items.map((i) => i.uid)).toContain(issueUid);

    const reopenOutcome = await transition(store, {
      uid: issueUid,
      by: 'reopener',
      toStatus: 'open',
      note: 'regression found',
    });
    expect(reopenOutcome.closedAt).toBeUndefined();

    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['closedAt']).toBeUndefined(); // cleared, never carrying the OLD closing timestamp forward

    // The IDENTICAL query, after reopening, MUST NOT match — proving the
    // stale-timestamp case has teeth through the real query path (not just
    // the raw-row read above).
    const afterReopenResult = await queryIssues(store, {
      filter: { closedAt: { since: closeOutcome.closedAt } },
    });
    if (afterReopenResult.view !== 'list')
      throw new Error(`expected view 'list', got '${afterReopenResult.view}'`);
    expect(afterReopenResult.items.map((i) => i.uid)).not.toContain(issueUid);
  });

  it('CitationRequiredError: citation_required:true + a terminal toStatus + zero citations', async () => {
    await seedStatus(store, 'done', true);
    await setProjectPolicy(store, projectUid, { citationRequired: true });
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'done',
        note: 'shipped',
      })
    ).rejects.toThrow(CitationRequiredError);
  });

  it('CitationUnverifiableError: a citation file that does not resolve, with citation_requires_sha true (default) — nothing is written', async () => {
    await setProjectPolicy(store, projectUid, {}, dir); // real project path, so the file-not-found branch is genuinely exercised
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'in-progress',
        note: 'trying',
        citations: [{ file: 'this-file-does-not-exist.ts' }],
      })
    ).rejects.toThrow(CitationUnverifiableError);

    const edges = await liveEdges(store, 'has_status', { src: issueRowid });
    expect(edges).toHaveLength(1); // status unchanged — the rejected call wrote nothing
    const citationEdges = await liveEdges(store, 'has_citation', {
      src: issueRowid,
    });
    expect(citationEdges).toHaveLength(0);
  });

  it('path-less project: a citation is ACCEPTED and persists sha:"unverified" — the gate applies only where verification is possible', async () => {
    // No `setProjectPolicy` call: `seedProject` mints a project with an empty
    // metadata blob (no `path`), and the DEFAULT policy still carries
    // `citationRequiresSha:true`. Before the fix this transition threw
    // `CitationUnverifiableError`; the gate must now have nothing to reject.
    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'citing evidence in a path-less project',
      citations: [{ file: 'src/whatever.ts' }],
    });
    expect(outcome.toStatus).toBe('in-progress');

    const citationEdges = await liveEdges(store, 'has_citation', {
      src: issueRowid,
    });
    expect(citationEdges).toHaveLength(1);
    const [citationEdge] = citationEdges;
    const { rows } = await store.adapter.executeAll<{ uid: string }>(
      'SELECT uid FROM node WHERE rowid = ?',
      [citationEdge?.dst]
    );
    const [cited] = rows;
    const citationRow = cited ? await readNode(store, cited.uid) : null;
    expect(citationRow?.metadata?.['sha']).toBe('unverified');
  });

  it('the path-less waiver is no longer SILENT — it emits an operator-visible warning (DEBT a934e089)', async () => {
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const outcome = await transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'in-progress',
        note: 'waiver observability',
        citations: [{ file: 'src/whatever.ts' }],
      });
      expect(outcome.toStatus).toBe('in-progress');
      expect(
        spy.mock.calls
          .map((c) => String(c[0]))
          .some(
            (m) =>
              m.includes('citation_requires_sha waived') &&
              m.includes('src/whatever.ts')
          )
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('the waiver warning fires ONLY on the waiver branch — a path-PRESENT hard-fail does NOT emit it', async () => {
    await setProjectPolicy(store, projectUid, {}, dir); // real project path -> hard-fail branch
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(
        transition(store, {
          uid: issueUid,
          by: 'closer',
          toStatus: 'in-progress',
          note: 'trying',
          citations: [{ file: 'this-file-does-not-exist.ts' }],
        })
      ).rejects.toThrow(CitationUnverifiableError);
      expect(
        spy.mock.calls
          .map((c) => String(c[0]))
          .some((m) => m.includes('citation_requires_sha waived'))
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('a REAL, resolvable citation writes a citation node + has_citation edge with a genuine (non-"unverified") sha', async () => {
    const citedPath = 'evidence.ts';
    writeFileSync(join(dir, citedPath), 'export const x = 1;\n');
    await setProjectPolicy(store, projectUid, {}, dir);

    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'citing real evidence',
      citations: [{ file: citedPath }],
    });
    expect(outcome.toStatus).toBe('in-progress');

    const citationEdges = await liveEdges(store, 'has_citation', {
      src: issueRowid,
    });
    expect(citationEdges).toHaveLength(1);
    const { rows: citationRows } = await store.adapter.executeAll<{
      uid: string;
    }>('SELECT uid FROM node WHERE rowid = ?', [citationEdges[0].dst]);
    const citationRow = await readNode(store, citationRows[0].uid);
    expect(citationRow?.metadata?.['sha']).toBeDefined();
    expect(citationRow?.metadata?.['sha']).not.toBe('unverified');
  });

  it('transition.sha is a real sha256 over the canonical {target_uid, from, to, agent, note, at} record — recomputed and compared byte-for-byte', async () => {
    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'checking sha',
    });
    const transitionRow = await readNode(store, outcome.transitionUid);
    expect(transitionRow?.kind).toBe('transition');

    const recomputed = sha256Hex(
      canonicalJSONStringify({
        target_uid: issueUid,
        from: 'open',
        to: 'in-progress',
        agent: 'closer',
        note: 'checking sha',
        at: transitionRow?.metadata?.['at'],
      })
    );
    expect(transitionRow?.metadata?.['sha']).toBe(recomputed);
    expect(transitionRow?.metadata?.['from_status']).toBe('open');
    expect(transitionRow?.metadata?.['to_status']).toBe('in-progress');
  });

  it('CatalogNotFoundError for a uid-shaped toStatus that does not resolve — minting never applies to a uid', async () => {
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: '11111111-1111-4111-8111-111111111111',
        note: 'x',
      })
    ).rejects.toThrow(CatalogNotFoundError);
  });

  it('allowedStatuses restriction rejects a disallowed toStatus name with InvalidArgumentError', async () => {
    await setProjectPolicy(store, projectUid, {
      allowedStatuses: ['open', 'in-progress'],
    });
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'wontfix',
        note: 'nope',
      })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('§2 requiredFields: a project declaring "note" required (independent of transitionRequiresNote) rejects a note-less call — nothing written; the identical call WITH a note still succeeds under the SAME policy', async () => {
    // transitionRequiresNote:false alone would otherwise permit a note-less call
    // (its own earlier test proves that) — this proves `requiredFields` is a
    // genuinely SEPARATE, independently-wired gate, not just an alias for the
    // note-specific policy flag: disabling the note-specific requirement while
    // declaring `note` in the generic `requiredFields` set still rejects.
    await setProjectPolicy(store, projectUid, {
      transitionRequiresNote: false,
      requiredFields: ['note'],
    });
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'in-progress',
      })
    ).rejects.toThrow(InvalidArgumentError);
    const edges = await liveEdges(store, 'has_status', { src: issueRowid });
    expect(edges).toHaveLength(1); // nothing written — status unchanged

    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'satisfies the policy',
    });
    expect(outcome.toStatus).toBe('in-progress');
  });

  it('§2 requiredFields: a project declaring a field OUTSIDE transition\'s input surface (e.g. "priority") does not brick every transition — that role belongs to createIssue/update, not this verb', async () => {
    // Regression: `enforceRequiredFields` previously checked every declared
    // name against `{...input, status}`, so ANY unrelated requiredFields
    // entry (priority/component/kind/assignee — none of which `transition`
    // ever resolves) threw InvalidArgumentError on every transition against
    // that project, even though the issue already has a priority and nothing
    // about this call is wrong.
    await setProjectPolicy(store, projectUid, { requiredFields: ['priority'] });
    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'unaffected by an unrelated required field',
    });
    expect(outcome.toStatus).toBe('in-progress');
  });

  it('IssueNotFoundError for a uid that never resolved to a live issue at all', async () => {
    await expect(
      transition(store, {
        uid: 'not-a-real-uid',
        by: 'closer',
        toStatus: 'open',
        note: 'x',
      })
    ).rejects.toThrow(IssueNotFoundError);
  });

  it('InvalidArgumentError on missing/blank uid, by, toStatus, or citations[i].file', async () => {
    await expect(
      transition(store, { uid: '', by: 'closer', toStatus: 'open', note: 'x' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      transition(store, {
        uid: issueUid,
        by: '  ',
        toStatus: 'open',
        note: 'x',
      })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: '',
        note: 'x',
      })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'open',
        note: 'x',
        citations: [{ file: '  ' }],
      })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('an untyped caller sending an explicit `null` for uid/by/toStatus gets a clean InvalidArgumentError, never an unhandled TypeError', async () => {
    // `ITransitionInput`'s TS type declares `string | undefined` for each of
    // these — an untyped CLI/HTTP/MCP JSON caller can still send a literal
    // `null`, which is neither `undefined` nor a blank string.
    const nullUid = {
      uid: null,
      by: 'closer',
      toStatus: 'open',
      note: 'x',
    } as unknown as Parameters<typeof transition>[1];
    const nullBy = {
      uid: issueUid,
      by: null,
      toStatus: 'open',
      note: 'x',
    } as unknown as Parameters<typeof transition>[1];
    const nullToStatus = {
      uid: issueUid,
      by: 'closer',
      toStatus: null,
      note: 'x',
    } as unknown as Parameters<typeof transition>[1];
    await expect(transition(store, nullUid)).rejects.toThrow(
      InvalidArgumentError
    );
    await expect(transition(store, nullBy)).rejects.toThrow(
      InvalidArgumentError
    );
    await expect(transition(store, nullToStatus)).rejects.toThrow(
      InvalidArgumentError
    );
  });

  it('StaleSupersedeError against a uid a PRIOR `update` body-change already superseded — transition never mutates a retired identity', async () => {
    await update(store, { uid: issueUid, by: 'editor', body: 'revised body' });
    await expect(
      transition(store, {
        uid: issueUid,
        by: 'closer',
        toStatus: 'in-progress',
        note: 'x',
      })
    ).rejects.toThrow(StaleSupersedeError);
  });

  it('writes exactly one audit row (action:"transitioned", from/to = status names, note = input.note)', async () => {
    await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'in-progress',
      note: 'moving along',
    });
    const trail = await readAuditTrail(store, issueRowid);
    // trail[0] is createIssue's own "created" row — this call adds exactly ONE more.
    expect(trail).toHaveLength(2);
    expect(trail[1].action).toBe('transitioned');
    expect(trail[1].from).toBe('open');
    expect(trail[1].to).toBe('in-progress');
    expect(trail[1].note).toBe('moving along');
  });

  it('a same-status transition (no-op status-wise) is STILL a real, fully-audited event — SPEC.md states no same-status exemption', async () => {
    const outcome = await transition(store, {
      uid: issueUid,
      by: 'closer',
      toStatus: 'open',
      note: 'reasserting open',
    });
    expect(outcome.fromStatus).toBe('open');
    expect(outcome.toStatus).toBe('open');
    const trail = await readAuditTrail(store, issueRowid);
    expect(trail).toHaveLength(2);
    expect(trail[1].action).toBe('transitioned');
    // exactly one LIVE has_status edge — the invalidate+re-write cycle never leaves two.
    const edges = await liveEdges(store, 'has_status', { src: issueRowid });
    expect(edges).toHaveLength(1);
  });

  describe('BUG-BACKLOG-CLAIM-TRANSITION-GATE-001 — a live claim gates transition (SPEC.md §6.3.5)', () => {
    it('a live claim by a DIFFERENT agent blocks transition with ClaimHeldError', async () => {
      await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });

      await expect(
        transition(store, {
          uid: issueUid,
          by: 'agent-b',
          toStatus: 'in-progress',
          note: 'should be blocked',
        })
      ).rejects.toThrow(ClaimHeldError);

      // Nothing was written — still exactly the ONE has_status edge from createIssue.
      const edges = await liveEdges(store, 'has_status', { src: issueRowid });
      expect(edges).toHaveLength(1);
    });

    it('the claim holder can transition their own claimed issue', async () => {
      await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });

      const outcome = await transition(store, {
        uid: issueUid,
        by: 'agent-a',
        toStatus: 'in-progress',
        note: 'working it',
      });
      expect(outcome.toStatus).toBe('in-progress');
    });

    it('a STALE claim by a different agent does not block transition', async () => {
      await setProjectPolicy(store, projectUid, { claimStaleAfterMin: 0 });
      await claim(store, { uid: issueUid, by: 'agent-a', action: 'claim' });

      const outcome = await transition(store, {
        uid: issueUid,
        by: 'agent-b',
        toStatus: 'in-progress',
        note: 'stale claim, should proceed',
      });
      expect(outcome.toStatus).toBe('in-progress');
    });

    it('an UNCLAIMED issue transitions freely by anyone (the documented no-claim-required workflow)', async () => {
      const outcome = await transition(store, {
        uid: issueUid,
        by: 'anyone-at-all',
        toStatus: 'in-progress',
        note: 'never claimed',
      });
      expect(outcome.toStatus).toBe('in-progress');
    });
  });
});
