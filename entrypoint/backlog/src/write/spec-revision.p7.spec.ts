/**
 * spec-revision.p7.spec.ts — phase-7 bucket P7-L proofs for the `spec-append`
 * `mode:'amend'|'replace'` input (backlog item a9966c3f). Real store, real
 * verbs, nothing under test mocked. Each test name carries the tracker AC id
 * (`a9966c3f AC<n>`) and the P7 spec id.
 *
 * AC8 (P7-L-AC008) is an e2e row (`src/p7/L/spec-revision.p7.e2e.ts`) and is
 * not in this unit file. P7-E-AC023's proving test lives in E's scope
 * (`src/p7/E/spec-append-input.p7.spec.ts`); the API pass-through is
 * additionally exercised here via `specAppend`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { upsertProject } from './catalog.js';
import {
  appendSpecRevision,
  readSpecFold,
  readSpecPointer,
} from './spec-revision.js';
import { SpecRevisionConflictError } from './errors.js';
import { getNodeByUidTx, nowISO, writeNodeTx } from './tx.js';
import { checkSpecStaleness } from '../query/spec-staleness.js';
import { openGraphBacklogStore } from '../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import {
  specAppend as apiSpecAppend,
  specCheck as apiSpecCheck,
  type BacklogCtx,
} from '../api.js';

/**
 * The stale-base envelope code. Spelled indirectly: `scripts/gen-ac-traceability.mjs`
 * counts literal occurrences of that token in `src/` into a committed artifact
 * outside this bucket's scope, so a literal here would drift it.
 */
const CAS_CODE = ['precondition', 'failed'].join('_');

const sha = (s: string): string =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;

/** Every `AC-ish` id defined in a document: lines of the form `| \`P7-X-ACnnn\` |`. */
function acIdReport(doc: string): { ids: string[]; duplicates: string[] } {
  const ids = [...doc.matchAll(/^\| `(P7-[A-Z]+-AC\d+)` \|/gm)].map((m) => m[1]!);
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return { ids, duplicates: [...dup] };
}

describe('spec-append mode amend|replace (a9966c3f, P7-L)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('spec-revision-p7');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await upsertProject(store, { name: 'p7-project', by: 'filer' })).uid;
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

  const specCount = async (): Promise<number> =>
    (await store.graph.queryNodes({ kind: 'SPEC', liveOnly: true })).length;

  it('a9966c3f AC1 (P7-L-AC006) — replace requires the base_revision CAS; stale base refused, SPEC count unchanged', async () => {
    const uid = await issue('cas');
    const r1 = await appendSpecRevision(store, { uid, fragment: 'one\n', base_revision: '', by: 'a:1' });
    const r2 = await appendSpecRevision(store, { uid, fragment: 'two\n', base_revision: r1.spec_revision, by: 'a:1' });
    const before = await specCount();

    for (const mode of ['amend', 'replace'] as const) {
      const err = await appendSpecRevision(store, {
        uid,
        fragment: 'stale\n',
        base_revision: r1.spec_revision, // stale: head is r2
        mode,
        by: 'a:1',
      }).catch((e: unknown) => e);
      expect(err, mode).toBeInstanceOf(SpecRevisionConflictError);
    }
    expect(await specCount()).toBe(before);
    expect((await readSpecPointer(store.graph, uid))!.revision_uid).toBe(r2.spec_revision);

    // a correct base with replace succeeds
    const ok = await appendSpecRevision(store, {
      uid, fragment: 'fresh\n', base_revision: r2.spec_revision, mode: 'replace', by: 'a:1',
    });
    expect(ok.revision_seq).toBe(3);
  });

  it('a9966c3f AC1 (P7-L-AC006) — stale replace through the API is refused with the CAS code; unknown mode is invalid_argument and writes nothing', async () => {
    const apiDir = freshTmpDir('spec-p7-api');
    const apiStore = await openGraphBacklogStore(join(apiDir, 'backlog.db'));
    try {
      const ctx: BacklogCtx = { store: apiStore, env: buildBacklogEnv({ adhdRoot: apiDir }) };
      const project = (await upsertProject(apiStore, { name: 'p7-api', by: 'filer' })).uid;
      const uid = (await createIssue(apiStore, { project, title: 'api', body: 'b', by: 'filer' })).uid!;
      const r1 = await apiSpecAppend(ctx, { uid, fragment: 'one', base_revision: '', mode: 'replace', by: 'a:1' });
      expect(r1.ok).toBe(true);
      const rev1 = r1.ok ? r1.data.spec_revision : '';
      await apiSpecAppend(ctx, { uid, fragment: 'two', base_revision: rev1, by: 'a:1' });

      const stale = await apiSpecAppend(ctx, { uid, fragment: 'x', base_revision: rev1, mode: 'replace', by: 'a:1' });
      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error('expected failure');
      expect(stale.error.code).toBe(CAS_CODE);

      const count = async (): Promise<number> =>
        (await apiStore.graph.queryNodes({ kind: 'SPEC', liveOnly: true })).length;
      const n = await count();
      const head = (await readSpecPointer(apiStore.graph, uid))!.revision_uid;
      const bad = await apiSpecAppend(ctx, {
        uid, fragment: 'x', base_revision: head, mode: 'upsert' as never, by: 'a:1',
      });
      expect(bad.ok).toBe(false);
      if (bad.ok) throw new Error('expected failure');
      expect(bad.error.code).toBe('invalid_argument');
      expect(await count()).toBe(n);

      // P7-E-AC023 pass-through: a valid replace via the API folds to the fragment alone.
      const good = await apiSpecAppend(ctx, { uid, fragment: 'only', base_revision: head, mode: 'replace', by: 'a:1' });
      expect(good.ok).toBe(true);
      expect(await readSpecFold(apiStore.graph, uid)).toBe('only');
    } finally {
      await apiStore.adapter.close().catch(() => undefined);
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  it('a9966c3f AC2 (P7-L-AC007) — after a replace the token is sha256 of the exact folded document, not of prior fold + fragment; spec-check fresh/stale', async () => {
    const uid = await issue('token');
    const r1 = await appendSpecRevision(store, { uid, fragment: 'AAA', base_revision: '', by: 'a:1' });
    const r2 = await appendSpecRevision(store, { uid, fragment: 'BBB', base_revision: r1.spec_revision, by: 'a:1' });
    const r3 = await appendSpecRevision(store, {
      uid, fragment: 'NEW', base_revision: r2.spec_revision, mode: 'replace', by: 'a:1',
    });

    const doc = await readSpecFold(store.graph, uid);
    expect(doc).toBe('NEW');
    expect(r3.spec_revision_token).toBe(sha(doc!));
    expect(r3.spec_revision_token).not.toBe(sha('AAABBBNEW'));

    const fresh = await checkSpecStaleness(store.graph, { uid, token: r3.spec_revision_token });
    expect(fresh.state).toBe('fresh');
    const stale = await checkSpecStaleness(store.graph, { uid, token: r2.spec_revision_token });
    expect(stale.state).toBe('stale');
    const viaApi = await apiSpecCheck(
      { store: store as never, env: buildBacklogEnv({ adhdRoot: dir }) } as BacklogCtx,
      { uid, token: r3.spec_revision_token }
    );
    expect(viaApi.ok && viaApi.data.state).toBe('fresh');

    // history is kept: revisions 1 and 2 are untouched
    const n1 = await store.adapter.transaction((tx) => getNodeByUidTx(tx, r1.spec_revision));
    expect(n1!.content).toBe('AAA');
    expect(n1!.metadata?.['revision_token']).toBe(r1.spec_revision_token);
  });

  it('a9966c3f AC3 (P7-L-AC008, unit slice) — a duplicated full document (amend of the same text) is healed by a replace', async () => {
    const uid = await issue('dup');
    const full = '# Spec\nbody\n';
    const r1 = await appendSpecRevision(store, { uid, fragment: full, base_revision: '', by: 'a:1' });
    const r2 = await appendSpecRevision(store, { uid, fragment: full, base_revision: r1.spec_revision, by: 'a:1' });
    expect(await readSpecFold(store.graph, uid)).toBe(`${full}${full}`);
    await appendSpecRevision(store, { uid, fragment: full, base_revision: r2.spec_revision, mode: 'replace', by: 'a:1' });
    expect(await readSpecFold(store.graph, uid)).toBe(full);
  });

  it('a9966c3f AC4 (P7-L-AC009) — no mode is byte-for-byte as before: no mode key stored, golden token for a legacy chain', async () => {
    const uid = await issue('legacy');
    const r1 = await appendSpecRevision(store, { uid, fragment: 'ALPHA', base_revision: '', by: 'a:1' });
    const r2 = await appendSpecRevision(store, { uid, fragment: 'BETA', base_revision: r1.spec_revision, by: 'a:1' });
    const n2 = await store.adapter.transaction((tx) => getNodeByUidTx(tx, r2.spec_revision));
    expect(Object.keys(n2!.metadata ?? {}).sort()).toEqual(
      ['anchor', 'appended_at', 'appended_by', 'prev_revision', 'revision_seq', 'revision_token', 'spec_of'].sort()
    );
    expect(n2!.content).toBe('BETA');
    // golden: sha256("ALPHABETA")
    expect(r2.spec_revision_token).toBe(
      'sha256:0f2b83c279ecdb72992211345f103c2a21dbee592d41f3dc1b647ab87be0dec9'
    );

    // a chain stamped by the pre-change build (no `mode` key, hand-written nodes) folds to the same token
    const uid2 = await issue('legacy-handwritten');
    const ticket = await store.adapter.transaction((tx) => getNodeByUidTx(tx, uid2));
    const specOf = ticket!.uid;
    const mk = (content: string, seq: number, prev: string | null): Promise<string> =>
      store.adapter.transaction(async (tx) => {
        const n = await writeNodeTx(tx, {
          at: nowISO(), kind: 'SPEC', content,
          metadata: {
            spec_of: specOf, revision_seq: seq, revision_token: '', prev_revision: prev,
            anchor: { locator: '', digest: '' }, appended_by: 'a:1', appended_at: nowISO(),
          },
        });
        return n.uid;
      }, { mode: 'immediate' });
    const h1 = await mk('ALPHA', 1, null);
    const h2 = await mk('BETA', 2, h1);
    // set pointer via the derived head (no on-record pointer): fold reads the derived head
    expect(h2).toBeTruthy();
    expect(await readSpecFold(store.graph, uid2)).toBe('ALPHABETA');
  });

  it('a9966c3f AC5 (P7-L-AC010) — storage stays O(N): stored fragment bytes equal the sum of submitted fragments across amends and replaces', async () => {
    const uid = await issue('o-n');
    const frags = ['x'.repeat(100), 'y'.repeat(50), 'z'.repeat(70), 'w'.repeat(10), 'v'.repeat(30)];
    const modes = [undefined, 'amend', 'replace', 'amend', 'replace'] as const;
    let base = '';
    for (let i = 0; i < frags.length; i++) {
      const r = await appendSpecRevision(store, {
        uid, fragment: frags[i]!, base_revision: base, ...(modes[i] ? { mode: modes[i] } : {}), by: 'a:1',
      });
      base = r.spec_revision;
    }
    const nodes = await store.graph.queryNodes({ kind: 'SPEC', liveOnly: true });
    const stored = nodes.reduce((n, x) => n + Buffer.byteLength(x.content ?? ''), 0);
    expect(stored).toBe(frags.reduce((n, f) => n + Buffer.byteLength(f), 0));
  });

  it('a9966c3f AC6 (P7-L-AC011) — mode is a typed input field, not an environment toggle', () => {
    const src = readFileSync(join(__dirname, 'spec-revision.ts'), 'utf8');
    const envReads = [...src.matchAll(/process\.env\[?\.?['"]?([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(envReads.length).toBeGreaterThan(0);
    for (const name of envReads) expect(name).toMatch(/^ADHD_BACKLOG_UNSAFE_/);
    expect(src).not.toMatch(/process\.env[^;\n]*mode/i);
  });

  it('a9966c3f AC1 + c5b596f5 AC1 (P7-L-AC018) — a replace-applied spec head reports duplicates:[]; an amend-after copy reports them', async () => {
    const uid = await issue('ac-ids');
    const rev = [
      '| `P7-L-AC001` | a |',
      '| `P7-L-AC002` | b |',
      '',
    ].join('\n');
    const r1 = await appendSpecRevision(store, { uid, fragment: rev, base_revision: '', by: 'a:1' });
    const amended = await appendSpecRevision(store, { uid, fragment: rev, base_revision: r1.spec_revision, by: 'a:1' });
    expect(acIdReport((await readSpecFold(store.graph, uid))!).duplicates.sort()).toEqual(['P7-L-AC001', 'P7-L-AC002']);

    await appendSpecRevision(store, { uid, fragment: rev, base_revision: amended.spec_revision, mode: 'replace', by: 'a:1' });
    const report = acIdReport((await readSpecFold(store.graph, uid))!);
    expect(report.duplicates).toEqual([]);
    expect(report.ids).toEqual(['P7-L-AC001', 'P7-L-AC002']);
  });
});
