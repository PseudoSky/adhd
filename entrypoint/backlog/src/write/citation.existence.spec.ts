/**
 * citation.existence.spec.ts — 050ea18f A-AC1/A-AC2/A-AC3/A-AC14 (S02.C1-C3,
 * ADR-0007 breaking #8, plus 8392a07c's gate-throw half): the citation gate
 * checks that evidence EXISTS, not that it sits inside the project.
 *
 * Real components: a real store, the real `api.ts` verbs, real files, a real
 * `git worktree`. Negative controls (run once, restored): re-adding the
 * `inRoot`-only acceptance (treat out-of-root as `target-missing`) turns the
 * out-of-root / worktree-only rows red; routing abstract anchors through the
 * path resolver turns the A-AC3 rows red; swallowing the persist step turns
 * the A-AC2 count row red.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

describe('050ea18f A-AC1..3,14 — citation existence gate (real store, real files)', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let repo: string;
  let outside: string;
  let projectUid: string;

  /** Abstract anchors carry no content hash, so `citationRequiresSha` (default true) refuses them (82e2c109); these rows exercise the persisted-outcome path, which needs the policy off. */
  async function policyOff(): Promise<void> {
    await tmp.store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ path: repo, policy: { citationRequiresSha: false } }),
      projectUid,
    ]);
  }

  async function citationCount(): Promise<number> {
    const r = await tmp.store.adapter.executeGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM node WHERE kind = 'citation' AND t_invalid IS NULL"
    );
    return Number(r?.c);
  }

  async function create(file: string): Promise<IOutcomeEnvelope<unknown>> {
    return api.create(ctx, {
      project: projectUid,
      title: `cites ${file}`.slice(0, 60),
      body: `body for ${file}`,
      by: 'filer',
      citations: [{ file }],
    });
  }

  async function citationsOf(uid: string): Promise<Array<Record<string, unknown>>> {
    const got = await api.get(ctx, { uid, fields: ['citations'] });
    if (!got.ok) throw new Error(JSON.stringify(got));
    return (got.data as unknown as { citations: Array<Record<string, unknown>> }).citations;
  }

  beforeEach(async () => {
    tmp = await openTmpStore('citation-existence');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    repo = join(tmp.dir, 'repo');
    outside = join(tmp.dir, 'outside');
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(repo, ['add', 'seed.txt']);
    git(repo, ['commit', '-qm', 'seed']);
    const p = await api.upsertProject(ctx, { name: 'cite-existence', path: repo, by: 'seed' });
    if (!p.ok) throw new Error(JSON.stringify(p));
    projectUid = (p.data as { uid: string }).uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('050ea18f A-AC1 — an EXISTING out-of-root file is persisted verified with its real sha', async () => {
    const file = join(outside, 'evidence.txt');
    writeFileSync(file, 'out-of-root evidence\n');
    const out = await create(file);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const [c] = await citationsOf((out as { data: { uid: string } }).data.uid);
    expect(c).toMatchObject({ file, verification: 'verified', sha: sha256('out-of-root evidence\n') });
  });

  it('050ea18f A-AC1 — a worktree-only path (a file that exists only in a second git worktree) is persisted verified', async () => {
    const wt = join(tmp.dir, 'wt');
    git(repo, ['worktree', 'add', '-q', wt, '-b', 'wt-branch']);
    const file = join(wt, 'only-in-worktree.txt');
    writeFileSync(file, 'worktree only\n');
    const out = await create(file);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const [c] = await citationsOf((out as { data: { uid: string } }).data.uid);
    expect(c).toMatchObject({ verification: 'verified', sha: sha256('worktree only\n') });
  });

  it('050ea18f A-AC1 — a DIRECTORY citation exits ok and is persisted unverified-with-reason target-is-directory', async () => {
    const out = await create(outside);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const [c] = await citationsOf((out as { data: { uid: string } }).data.uid);
    expect(c).toMatchObject({ sha: 'unverified', verification: 'unverified-with-reason', unverifiedReason: 'target-is-directory' });
  });

  it('050ea18f A-AC1/A-AC14 — a NON-EXISTENT target is still refused under citation_requires_sha, nothing written; with the policy off it is persisted target-missing', async () => {
    const before = await citationCount();
    const missing = join(outside, 'nope.txt');
    const refused = await create(missing);
    expect(refused.ok).toBe(false);
    expect((refused as { error: { code: string } }).error.code).toBe('precondition_failed');
    expect(await citationCount()).toBe(before);

    await tmp.store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ path: repo, policy: { citationRequiresSha: false } }),
      projectUid,
    ]);
    const persisted = await create(missing);
    expect(persisted.ok, JSON.stringify(persisted)).toBe(true);
    const [c] = await citationsOf((persisted as { data: { uid: string } }).data.uid);
    expect(c).toMatchObject({ verification: 'unverified-with-reason', unverifiedReason: 'target-missing' });
  });

  it('050ea18f A-AC2 — never drops: citation nodes persisted == citations passed, and get returns the outcome for each', async () => {
    await policyOff();
    const real = join(outside, 'real.txt');
    writeFileSync(real, 'real\n');
    const before = await citationCount();
    const out = await api.create(ctx, {
      project: projectUid,
      title: 'three citations',
      body: 'a real file, a directory and an abstract anchor',
      by: 'filer',
      citations: [{ file: real }, { file: outside }, { file: 'url:https://example.com/x' }],
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(await citationCount()).toBe(before + 3);
    const cs = await citationsOf((out as { data: { uid: string } }).data.uid);
    expect(cs.map((c) => c['verification']).sort()).toEqual(['unverified-with-reason', 'unverified-with-reason', 'verified']);
    expect(cs.find((c) => c['file'] === outside)?.['unverifiedReason']).toBe('target-is-directory');
  });

  it.each([
    ['url:https://example.com/doc', 'url'],
    ['registry:npm/@adhd/backlog', 'registry'],
    ['query:status=open AND priority=high', 'query'],
  ])('050ea18f A-AC3 — abstract anchor %s is accepted, target_type=%s, outcome recorded (never a hard refusal)', async (anchor, kind) => {
    await policyOff();
    const out = await create(anchor);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const [c] = await citationsOf((out as { data: { uid: string } }).data.uid);
    expect(c).toMatchObject({
      file: anchor,
      targetType: kind,
      sha: 'unverified',
      verification: 'unverified-with-reason',
      unverifiedReason: 'abstract-anchor-unchecked',
    });
  });

  it('050ea18f A-AC3 — a malformed url: anchor is invalid_argument and writes nothing', async () => {
    const before = await citationCount();
    const out = await create('url:not a url');
    expect(out.ok).toBe(false);
    expect((out as { error: { code: string } }).error.code).toBe('invalid_argument');
    expect(await citationCount()).toBe(before);
  });
});
