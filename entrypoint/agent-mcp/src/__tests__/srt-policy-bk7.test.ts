/**
 * BK7 (backlog 515a2b50, plan 9ed453c1) — pure unit tests for the shell-sandbox write allow list
 * (`agent.shell.sandbox.extraAllowWrite`). No subprocess: the real-srt proofs (AC7.1/AC7.2/AC7.4)
 * live in `srt-policy-bk7.e2e.test.ts`.
 *
 * 515a2b50 AC7.3: the rendered policy holds exactly the documented allow list, mode 0600, in the
 * run-policy temp dir. Validation (architect verdict Q5) is fail-loud.
 */
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SRT_EXTRA_ALLOW_WRITE,
  SrtPolicyConfigError,
  defaultSrtAllowWrite,
  defaultSrtDenyRead,
  provisionRunSrtPolicy,
  provisionSrtPolicy,
  removeRunSrtPolicy,
  resolveSrtExtraAllowWrite,
  srtRunPolicyDir,
  validateSrtExtraAllowWrite,
} from '../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HOME = '/home/u';
const DENY = [join(HOME, '.npmrc'), join(HOME, '.ssh'), join(HOME, '.aws')];
const validate = (entries: string[]) => validateSrtExtraAllowWrite(entries, HOME, DENY);

describe('515a2b50 AC7.3 validateSrtExtraAllowWrite (fail loud, verdict Q5)', () => {
  it('expands ~/ and accepts a dir under home (default ~/.adhd/backlog)', () => {
    expect(validate(['~/.adhd/backlog'])).toEqual([join(HOME, '.adhd', 'backlog')]);
    expect(validate([join(HOME, 'work', 'scratch'), '~/work/scratch'])).toEqual([join(HOME, 'work', 'scratch')]);
  });

  it.each([
    ['empty string', ''],
    ['relative path', 'adhd/backlog'],
    ['bare ~user form', '~root/x'],
    ['outside home', '/etc'],
    ['outside home (sibling prefix)', '/home/u2/x'],
    ['$HOME itself', '~'],
    ['$HOME absolute', HOME],
    ['ancestor of home', '/home'],
    ['filesystem root', '/'],
    ['~/.adhd itself', '~/.adhd'],
    ['~/.ssh', '~/.ssh'],
    ['inside ~/.ssh', '~/.ssh/keys'],
    ['a denyRead file', '~/.npmrc'],
    ['inside a denyRead dir', '~/.aws/sso'],
    ['.. segment', '~/.adhd/backlog/../agent-mcp'],
    ['.. escaping home', '~/../../etc'],
    ['glob *', '~/.adhd/*'],
    ['glob ?', '~/.adhd/back?og'],
    ['glob []', '~/.adhd/[b]acklog'],
    ['glob {}', '~/.adhd/{backlog,x}'],
  ])('rejects %s', (_label, entry) => {
    expect(() => validate([entry])).toThrow(SrtPolicyConfigError);
  });

  it('error message names the key and the offending entry', () => {
    expect(() => validate(['~/.ssh'])).toThrow(/agent\.shell\.sandbox\.extraAllowWrite.*~\/\.ssh/);
  });

  it('one bad entry rejects the whole list (never silently dropped)', () => {
    expect(() => validate(['~/.adhd/backlog', '/etc'])).toThrow(SrtPolicyConfigError);
  });

  it('the shipped default is exactly [~/.adhd/backlog] and validates against the real home', () => {
    expect([...DEFAULT_SRT_EXTRA_ALLOW_WRITE]).toEqual(['~/.adhd/backlog']);
    expect(resolveSrtExtraAllowWrite()).toEqual([join(homedir(), '.adhd', 'backlog')]);
  });
});

describe('515a2b50 AC7.3 rendered policy golden', () => {
  let dir = '';
  beforeEach(async () => {
    const root = join(REPO_ROOT, 'tmp', 'agent-mcp');
    await mkdir(root, { recursive: true });
    dir = await mkdtemp(join(root, 'srt-bk7-'));
  });
  afterEach(async () => {
    removeRunSrtPolicy();
    await rm(dir, { recursive: true, force: true });
  });

  it('allowWrite is exactly: static caches + ~/.adhd/backlog (+ the cwd); denyRead unchanged', async () => {
    const settingsPath = join(dir, 'policy.json');
    provisionSrtPolicy({ settingsPath, allowWrite: ['/work/cwd'] });
    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      filesystem: { allowWrite: string[]; denyRead: string[] };
    };
    const backlog = join(homedir(), '.adhd', 'backlog');
    expect(written.filesystem.allowWrite).toEqual([...defaultSrtAllowWrite(), backlog, '/work/cwd']);
    expect(written.filesystem.denyRead).toEqual(defaultSrtDenyRead());
    // least privilege: nothing broader than the backlog dir under ~/.adhd, and never $HOME.
    expect(written.filesystem.allowWrite).not.toContain(join(homedir(), '.adhd'));
    expect(written.filesystem.allowWrite).not.toContain(homedir());
  });

  it('extraAllowWrite: [] renders no backlog allow (the key is load-bearing)', async () => {
    const settingsPath = join(dir, 'policy-empty.json');
    provisionSrtPolicy({ settingsPath, extraAllowWrite: [] });
    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as { filesystem: { allowWrite: string[] } };
    expect(written.filesystem.allowWrite).toEqual(defaultSrtAllowWrite());
  });

  it('an invalid extra root throws before anything is written', () => {
    const settingsPath = join(dir, 'policy-bad.json');
    expect(() => provisionSrtPolicy({ settingsPath, extraAllowWrite: ['~/.ssh'] })).toThrow(SrtPolicyConfigError);
    expect(() => statSync(settingsPath)).toThrow();
  });

  it('the per-run policy file is mode 0600 inside the run-policy temp dir', () => {
    const roots = { temp: join(dir, 'temp') };
    const result = provisionRunSrtPolicy('/work/cwd', {} as NodeJS.ProcessEnv, roots);
    expect(result.path).toBe(join(srtRunPolicyDir(roots), `run-${process.pid}.json`));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it('re-provisioning an existing wider-mode file tightens it back to 0600', async () => {
    const settingsPath = join(dir, 'policy-mode.json');
    provisionSrtPolicy({ settingsPath });
    const { chmodSync } = await import('node:fs');
    chmodSync(settingsPath, 0o644);
    provisionSrtPolicy({ settingsPath, allowWrite: ['/new/root'] }); // content change => rewrite
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });
});
