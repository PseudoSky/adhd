/**
 * citation.cross-repo.spec.ts
 *
 * guards: a revision-pinned citation is verified only against the item's own project repo, so an item filed under
 *   project A that cites a file in repo B at a B commit sha is refused with "the pinned revision does not contain it"
 *   even though the sha and the file exist in B.
 * tier: P
 * gap: This cannot be observed at tier S because the verdict is whatever a real git binary resolves from the object
 *   stores of real repositories, which a stubbed git call would only echo back.
 * cites: owner instruction "remove whatever hard block backlog creates on citations needing to reference files in
 *   their own project"; criteria (a) cross-repo absolute accepted, (b) sha in neither repo refused naming the repos
 *   tried, (c) repo-relative path found via a registered sibling project, (d) own-project citation unchanged.
 * red run: against the unfixed verifier (citation.ts and errors.ts at HEAD), `npx vitest run
 *   src/write/citation.cross-repo.spec.ts` in entrypoint/backlog failed 4 of 5 rows (a, a-unregistered, b, c; d passed) on
 *   `expect(out.ok).toBe(true)` with 'Citation target "<repo-b>/pkg/b-only.txt" could not be verified ... the pinned
 *   revision does not contain it', and on (b) the missing 'repos tried:' text.
 *
 * Real components: real store, real `api.ts` verbs, real tmp git repos (created under the store's tmp dir, removed in
 * teardown by `tmp.cleanup()`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

function makeRepo(dir: string, file: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-qm', 'seed']);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('citations verify against the repo that contains the cited path', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let repoA: string;
  let repoB: string;
  let shaA: string;
  let shaB: string;
  let projectA: string;

  async function createCiting(file: string, revision: string) {
    return api.create(ctx, {
      project: projectA,
      title: `cites ${file}`.slice(0, 60),
      body: 'cross-repo citation',
      by: 'filer',
      citations: [{ file, revision }],
    });
  }

  beforeEach(async () => {
    tmp = await openTmpStore('citation-cross-repo');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    repoA = join(tmp.dir, 'repo-a');
    repoB = join(tmp.dir, 'repo-b');
    shaA = makeRepo(repoA, 'a-file.txt', 'in A\n');
    shaB = makeRepo(repoB, 'pkg/b-only.txt', 'in B\n');
    const a = await api.upsertProject(ctx, { name: 'proj-a', path: repoA, by: 'seed' });
    const b = await api.upsertProject(ctx, { name: 'proj-b', path: repoB, by: 'seed' });
    if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
    projectA = (a.data as { uid: string }).uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('(a) an absolute path into repo B at a B sha is accepted for an item in project A', async () => {
    const out = await createCiting(join(repoB, 'pkg/b-only.txt'), shaB);
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it('(a) an absolute path into an UNREGISTERED repo is accepted via its enclosing git repo', async () => {
    const repoC = join(tmp.dir, 'repo-c');
    const shaC = makeRepo(repoC, 'c.txt', 'in C\n');
    const out = await createCiting(join(repoC, 'c.txt'), shaC);
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it('(b) a sha present in neither repo is refused, and the message lists the repos tried', async () => {
    const out = await createCiting(join(repoB, 'pkg/b-only.txt'), '0'.repeat(40));
    expect(out.ok).toBe(false);
    const err = (out as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('precondition_failed');
    expect(err.message).toContain('the pinned revision does not contain it');
    expect(err.message).toContain('repos tried:');
    expect(err.message).toContain(repoA);
    expect(err.message).toContain('repo-b');
  });

  it('(c) a repo-relative path that exists only in registered project B is accepted at a B sha', async () => {
    const out = await createCiting('pkg/b-only.txt', shaB);
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("(d) a citation into the item's own project repo is unchanged: accepted at its sha, refused at a foreign sha", async () => {
    const rel = await createCiting('a-file.txt', shaA);
    expect(rel.ok, JSON.stringify(rel)).toBe(true);
    const abs = await createCiting(join(repoA, 'a-file.txt'), shaA);
    expect(abs.ok, JSON.stringify(abs)).toBe(true);
    const refused = await createCiting('a-file.txt', shaB);
    expect(refused.ok).toBe(false);
    expect((refused as { error: { code: string } }).error.code).toBe('precondition_failed');
  });
});
