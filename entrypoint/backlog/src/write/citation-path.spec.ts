/**
 * citation-path.spec.ts — the citation-path containment helpers (BUG
 * c6d35272). Pure path logic + real filesystem fixtures (a real temp dir, a
 * real symlink) — never a mocked `fs`, because the whole point of the
 * carve-out is how it behaves against the REAL filesystem's `realpath`
 * resolution.
 *
 * The security properties this proves, each independently:
 * - a `..` traversal cannot widen the surface, even when the target exists;
 * - a symlink inside the root pointing outside it is rejected (canonical
 *   containment resolves the link — this is also the sibling defect
 *   c6d90ddf);
 * - an arbitrary absolute path outside every root is rejected;
 * - the default external roots are EMPTY, so the machine-global backlog store
 *   under `~/.adhd/backlog` is not citable (BUG 62059b57 follow-up).
 */
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import {
  canonicalizePath,
  defaultCitationAllowedExternalRoots,
  displayExternalRoot,
  isMissingPathError,
  isPathWithin,
  resolveCitationTarget,
} from './citation-path.js';

describe('citation-path — defaultCitationAllowedExternalRoots', () => {
  it('is [] — the runtime grants NO machine-global default external root', () => {
    expect(defaultCitationAllowedExternalRoots()).toEqual([]);
  });

  it('is $HOME-INDEPENDENT: redirecting $HOME does not conjure a default root', () => {
    // The default no longer reads `homedir()` (it is the empty array), so a
    // per-invocation sandbox sees exactly the same surface. The function stays
    // lazy so the call contract is unchanged if a root is ever re-introduced.
    const original = process.env.HOME;
    const fake = freshTmpDir('citation-path-home');
    process.env.HOME = fake;
    try {
      expect(defaultCitationAllowedExternalRoots()).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it('does NOT default to ~/.adhd, nor to the store home ~/.adhd/backlog (BUG 62059b57 + the store carve-out)', () => {
    // Neither the machine-global secrets parent (`~/.adhd/.env`, every other
    // project's DB) NOR the store's own data home (`~/.adhd/backlog`, which
    // holds `production/data/backlog-v2.db` + its backups) may be inside the
    // default surface. Asserted on the VALUE, not the shape.
    const roots = defaultCitationAllowedExternalRoots();
    expect(roots).not.toContain(join(homedir(), '.adhd'));
    expect(roots).not.toContain(join(homedir(), '.adhd', 'backlog'));
    expect(roots).toEqual([]);
  });
});

describe('citation-path — isMissingPathError (the shared ENOENT/ENOTDIR taxonomy)', () => {
  it('is true for ENOENT and ENOTDIR, false for every other errno (EACCES/EISDIR/ELOOP/…), and false for a non-error', () => {
    expect(isMissingPathError({ code: 'ENOENT' })).toBe(true);
    expect(isMissingPathError({ code: 'ENOTDIR' })).toBe(true);
    expect(isMissingPathError({ code: 'EACCES' })).toBe(false);
    expect(isMissingPathError({ code: 'EISDIR' })).toBe(false);
    expect(isMissingPathError({ code: 'ELOOP' })).toBe(false);
    expect(isMissingPathError(new Error('no code'))).toBe(false);
    expect(isMissingPathError(undefined)).toBe(false);
    expect(isMissingPathError('ENOENT')).toBe(false);
  });
});

describe('citation-path — displayExternalRoot', () => {
  it('~-anchors a root under the home directory and leaves others absolute', () => {
    const home = homedir();
    expect(displayExternalRoot(join(home, '.adhd'))).toBe('~/.adhd');
    expect(displayExternalRoot(home)).toBe('~');
    expect(displayExternalRoot('/etc')).toBe('/etc');
  });
});

describe('citation-path — isPathWithin (lexical, via relative())', () => {
  it('accepts equal and descendant paths, rejects ancestors and name-prefix siblings', () => {
    expect(isPathWithin('/a/b', '/a/b')).toBe(true);
    expect(isPathWithin('/a/b', '/a/b/c')).toBe(true);
    // The exact case a bare `startsWith('/a/b')` would get WRONG.
    expect(isPathWithin('/a/b', '/a/bc')).toBe(false);
    expect(isPathWithin('/a/b', '/a')).toBe(false);
  });
});

describe('citation-path — canonicalizePath', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshTmpDir('citation-canon');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('realpaths an existing path', async () => {
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'export const a = 1;\n');
    expect(await canonicalizePath(file)).toBe(realpathSync(file));
  });

  it('resolves a non-existent tail against the nearest EXISTING ancestor (ENOENT)', async () => {
    const missing = join(dir, 'nested', 'deep', 'x.ts');
    expect(await canonicalizePath(missing)).toBe(
      join(realpathSync(dir), 'nested', 'deep', 'x.ts')
    );
  });

  it('resolves a symlink to its real target', async () => {
    const target = join(dir, 'target.ts');
    const link = join(dir, 'link.ts');
    writeFileSync(target, 'export const t = 1;\n');
    symlinkSync(target, link);
    expect(await canonicalizePath(link)).toBe(realpathSync(target));
  });
});

describe('citation-path — resolveCitationTarget (canonical containment against projectRoot ∪ allowedRoots)', () => {
  let dir: string;
  let projectRoot: string;
  let allowedRoot: string;

  beforeEach(() => {
    dir = freshTmpDir('citation-target');
    projectRoot = join(dir, 'proj');
    allowedRoot = join(dir, 'allowed');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(allowedRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts an in-project relative target', async () => {
    const file = join(projectRoot, 'in.ts');
    writeFileSync(file, 'export const x = 1;\n');
    const r = await resolveCitationTarget(projectRoot, 'in.ts', []);
    expect(r.accepted).toBe(true);
    expect(r.candidate).toBe(realpathSync(file));
  });

  it('accepts an absolute target under an allowed external root', async () => {
    const file = join(allowedRoot, 'ext.ts');
    writeFileSync(file, 'export const x = 1;\n');
    const r = await resolveCitationTarget(projectRoot, file, [allowedRoot]);
    expect(r.accepted).toBe(true);
    expect(r.candidate).toBe(realpathSync(file));
  });

  it('rejects a target outside the project root and every allowed root', async () => {
    const file = join(dir, 'outside.ts');
    writeFileSync(file, 'export const x = 1;\n');
    const r = await resolveCitationTarget(projectRoot, file, [allowedRoot]);
    expect(r.accepted).toBe(false);
  });

  it('rejects a ".." traversal even when the target file EXISTS', async () => {
    writeFileSync(join(dir, 'outside.ts'), 'export const x = 1;\n');
    const r = await resolveCitationTarget(projectRoot, '../outside.ts', []);
    expect(r.accepted).toBe(false);
  });

  it('rejects a symlink inside the root that points OUTSIDE it (an escape cannot widen the allowlist)', async () => {
    const secret = join(dir, 'secret.ts');
    writeFileSync(secret, 'export const secret = 1;\n');
    symlinkSync(secret, join(projectRoot, 'link.ts'));
    const r = await resolveCitationTarget(projectRoot, 'link.ts', []);
    expect(r.accepted).toBe(false);
  });

  it('accepts a missing file inside the project root — existence is the caller readFile\'s concern', async () => {
    const r = await resolveCitationTarget(projectRoot, 'not-yet.ts', []);
    expect(r.accepted).toBe(true);
  });

  it('REJECTS the shared backlog store + its backups under the DEFAULT roots (BUG 62059b57 follow-up — negative control)', async () => {
    // The residual this change closes: with the OLD default
    // (`[~/.adhd/backlog]`) a citation could resolve INTO the machine-global
    // backlog graph — `production/data/backlog-v2.db` and the `backup-*`
    // snapshots beside it. $HOME is redirected to a hermetic tree so the store
    // paths are built deterministically (the real machine's ~/.adhd/backlog
    // need not exist, and this test never reads the real store). With the old
    // default each candidate lies INSIDE the root, so the `false` assertion
    // goes RED; the empty default is what makes it GREEN.
    const fakeHome = freshTmpDir('citation-store-home');
    const original = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const storePath = join(
        fakeHome,
        '.adhd',
        'backlog',
        'production',
        'data',
        'backlog-v2.db'
      );
      const backupPath = join(
        fakeHome,
        '.adhd',
        'backlog',
        'backup-20260808',
        'data',
        'backlog.db'
      );
      mkdirSync(dirname(storePath), { recursive: true });
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(storePath, 'store-file-placeholder-bytes\n');
      writeFileSync(backupPath, 'store-file-placeholder-bytes\n');

      for (const target of [storePath, backupPath]) {
        const r = await resolveCitationTarget(
          projectRoot,
          target,
          defaultCitationAllowedExternalRoots()
        );
        expect(r.accepted).toBe(false);
        // The candidate is still RESOLVED — containment was computed against
        // the real path, it simply is not accepted.
        expect(r.candidate).toBe(realpathSync(target));
      }
    } finally {
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
