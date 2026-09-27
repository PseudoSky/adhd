/**
 * anchor-check.spec.ts — C3's anchor ladder, driven against a REAL git work
 * tree (a real `git init` + commits + `git rm`, exercised through the real
 * `git` CLI, never a stubbed `child_process`).
 *
 * AC7 is the load-bearing one: a file deleted since filing must be diagnosed
 * by the CHEAP first rung (`exists_at_head`), not a full content re-resolve —
 * a full re-resolve that ran first would still report `stale`, so the test
 * asserts the METHOD too. The negative control is a local edit to
 * `anchor-check.ts` that forces the ladder to run `full_resolve` first; with
 * that edit AC7 goes RED (documented in the ticket return).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshTmpDir, osTmpDir } from '../test/helpers/tmp-store.js';
import { checkAnchor, existsAtHead, parseAnchor } from './anchor-check.js';
import { AnchorLocatorInvalidError } from './errors.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A filing time 60s after "now" — comfortably after every commit the test
 * just made, so `git log --since` treats the file as untouched. A far-future
 * literal (2999) is NOT usable: git's approxidate clamps it and the filter
 * silently matches everything.
 */
function soonAfterCommit(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

describe('anchor-check — parseAnchor (closed grammar)', () => {
  it('parses path (with and without an optional :line), url, query and registry', () => {
    expect(parseAnchor('path:dist/index.js')).toEqual({
      scheme: 'path',
      target: 'dist/index.js',
    });
    expect(parseAnchor('path:src/a.ts:42')).toEqual({
      scheme: 'path',
      target: 'src/a.ts',
      line: 42,
    });
    expect(parseAnchor('url:https://example.com/x')).toEqual({
      scheme: 'url',
      target: 'https://example.com/x',
    });
    expect(parseAnchor('query:SELECT 1')).toEqual({
      scheme: 'query',
      target: 'SELECT 1',
    });
    expect(parseAnchor('registry:pkg@1.2.3')).toEqual({
      scheme: 'registry',
      target: 'pkg@1.2.3',
    });
  });

  it('rejects a blank locator, a missing scheme, an unknown scheme and an empty body with AnchorLocatorInvalidError', () => {
    for (const bad of ['', '   ', 'dist/index.js', 'sha:abc', 'path:', 'url:']) {
      expect(() => parseAnchor(bad)).toThrow(AnchorLocatorInvalidError);
    }
  });
});

describe('anchor-check — checkAnchor ladder (real git CLI)', () => {
  let repo: string;
  const now = '2026-09-27T00:00:00.000Z';
  const by = 'checker:1';

  beforeEach(() => {
    repo = freshTmpDir('anchor-check-repo');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'anchor test']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function commit(rel: string, content: string): void {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
    git(repo, ['add', rel]);
    git(repo, ['commit', '-qm', `add ${rel}`]);
  }

  it('verifies an anchor whose file exists at HEAD and is untouched since filing', () => {
    commit('evidence.txt', 'c-one');
    const check = checkAnchor(
      { locator: 'path:evidence.txt', digest: sha256('c-one') },
      // A filing time after the commit means no commit is "since filing" —
      // the file was committed before the attestation was filed.
      { root: repo, sinceISO: soonAfterCommit(), now, by }
    );
    expect(check.state).toBe('verified');
    expect(check.method).toBe('changed_since');
    expect(check.reason).toBeUndefined();
  });

  it('AC7 — a file deleted since filing is `stale` via the cheap exists_at_head rung', () => {
    commit('gone.txt', 'c-one');
    git(repo, ['rm', '-q', 'gone.txt']);
    git(repo, ['commit', '-qm', 'remove gone.txt']);

    expect(existsAtHead(repo, 'gone.txt')).toBe(false);

    const check = checkAnchor(
      { locator: 'path:gone.txt', digest: sha256('c-one') },
      { root: repo, sinceISO: soonAfterCommit(), full: true, now, by }
    );
    expect(check.state).toBe('stale');
    // AC7's teeth: the CHEAP rung produced the diagnosis — a ladder that ran
    // full_resolve first would still say `stale` but with method full_resolve.
    expect(check.method).toBe('exists_at_head');
    expect(check.reason).toBeDefined();
  });

  it('full re-resolve verifies a matching digest and flags a mismatched one as stale', () => {
    commit('r.txt', 'c-one');
    const matching = checkAnchor(
      { locator: 'path:r.txt', digest: sha256('c-one') },
      { root: repo, sinceISO: '2000-01-01T00:00:00.000Z', full: true, now, by }
    );
    expect(matching.state).toBe('verified');
    expect(matching.method).toBe('full_resolve');

    const mismatched = checkAnchor(
      { locator: 'path:r.txt', digest: sha256('some-other-content') },
      { root: repo, sinceISO: '2000-01-01T00:00:00.000Z', full: true, now, by }
    );
    expect(mismatched.state).toBe('stale');
    expect(mismatched.method).toBe('full_resolve');
    expect(mismatched.reason).toBeDefined();
  });

  it('changed since filing without `full` is `stale` via changed_since (no content read)', () => {
    commit('changed.txt', 'c-one');
    // A `since` in the past means every commit including the one that added
    // the file counts as "changed since filing".
    const check = checkAnchor(
      { locator: 'path:changed.txt', digest: sha256('c-one') },
      { root: repo, sinceISO: '2000-01-01T00:00:00.000Z', full: false, now, by }
    );
    expect(check.state).toBe('stale');
    expect(check.method).toBe('changed_since');
  });

  it('a url:/registry: locator with no checker is explicitly `unverified`, never absent', () => {
    for (const locator of ['url:https://example.com/x', 'registry:pkg@1.2.3']) {
      const check = checkAnchor(
        { locator, digest: sha256('x') },
        { root: repo, now, by }
      );
      expect(check.state).toBe('unverified');
      expect(check.method).toBe('none');
      expect(check.reason).toBeDefined();
    }
  });

  it('a missing root or a non-repo root is `unknown`, not a false `stale`', () => {
    const noRoot = checkAnchor(
      { locator: 'path:a.txt', digest: sha256('x') },
      { now, by }
    );
    expect(noRoot.state).toBe('unknown');
    expect(noRoot.method).toBe('none');

    const notRepo = osTmpDir('anchor-check-not-a-repo');
    try {
      const check = checkAnchor(
        { locator: 'path:a.txt', digest: sha256('x') },
        { root: notRepo, now, by }
      );
      expect(check.state).toBe('unknown');
      expect(check.method).toBe('none');
      expect(check.reason).toContain('git work tree');
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('existsAtHead is true for a committed file and false for an untracked one', () => {
    commit('present.txt', 'c-one');
    expect(existsAtHead(repo, 'present.txt')).toBe(true);
    expect(existsAtHead(repo, 'never-tracked.txt')).toBe(false);
    writeFileSync(join(repo, 'untracked.txt'), 'x');
    expect(existsAtHead(repo, 'untracked.txt')).toBe(false);
  });
});
