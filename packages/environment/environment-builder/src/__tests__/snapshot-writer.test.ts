import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { atomicWrite, resolveSnapshotPath } from '../snapshot-writer';
import type { Roots } from '../roots';

const cleanupDirs: string[] = [];
function mkFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhd-env-snapwriter-'));
  cleanupDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveSnapshotPath', () => {
  it('resolves under the active scope root', () => {
    const roots: Roots = { system: '/sys', global: '/glob', project: '/proj' };
    expect(resolveSnapshotPath(roots, 'project')).toBe(join('/proj', 'adhd-environment.json'));
    expect(resolveSnapshotPath(roots, 'global')).toBe(join('/glob', 'adhd-environment.json'));
  });
});

describe('atomicWrite', () => {
  it('creates the parent directory tree and writes JSON content', () => {
    const dir = mkFixtureDir();
    const target = join(dir, 'nested', 'deep', 'adhd-environment.json');
    atomicWrite(target, { hello: 'world' });
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ hello: 'world' });
  });

  it('never leaves a stale .tmp file behind on success', () => {
    const dir = mkFixtureDir();
    const target = join(dir, 'adhd-environment.json');
    atomicWrite(target, { a: 1 });
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('writes the file owner-only (mode 0o600) by default — never world-readable', () => {
    const dir = mkFixtureDir();
    const target = join(dir, 'adhd-environment.json');
    atomicWrite(target, { a: 1 });
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('a second write atomically replaces the first (readers never see a partial file)', () => {
    const dir = mkFixtureDir();
    const target = join(dir, 'adhd-environment.json');
    atomicWrite(target, { version: 1 });
    atomicWrite(target, { version: 2 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ version: 2 });
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});
