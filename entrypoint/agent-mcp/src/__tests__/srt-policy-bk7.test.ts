/**
 * BK7 (backlog 515a2b50, plan 9ed453c1) — pure unit tests for the shell-sandbox write allow list
 * (`agent.shell.sandbox.extraAllowWrite`) and its security-review corrections. No `srt`/backlog
 * subprocess: the real-srt proofs live in `srt-policy-bk7.e2e.test.ts` (ADR-0009 e2e lane).
 *
 * 515a2b50 AC7.3: the rendered policy holds exactly the documented allow list, mode 0600, in the
 * run-policy temp dir; validation (architect verdict Q5) is fail-loud.
 * 515a2b50 SEC-F1 narrow default + managed denyWrite, SEC-F3 scope-pinned key, SEC-F4 allowlist
 * validator, SEC-F5 realpath/case/NFC, SEC-F7 global file untouched + narrowing takes effect, SEC-F8
 * O_EXCL 0600 policy file.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SRT_BACKLOG_DENY_WRITE,
  DEFAULT_SRT_EXTRA_ALLOW_WRITE,
  SrtPolicyConfigError,
  defaultSrtAllowWrite,
  defaultSrtDenyRead,
  defaultSrtDenyWrite,
  provisionRunSrtPolicy,
  provisionSrtPolicy,
  removeRunSrtPolicy,
  resolveRealPrefix,
  srtRunPolicyDir,
  validateSrtExtraAllowWrite,
} from '../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRATCH = join(REPO_ROOT, 'tmp', 'agent-mcp');

let dir = '';
/** A real, symlink-resolved scratch HOME (so realpath-based assertions are exact). */
let home = '';

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(join(SCRATCH, 'srt-bk7u-'));
  home = realpathSync(join(dir, (mkdirSync(join(dir, 'home')), 'home')));
  for (const d of ['.ssh', '.claude', '.gnupg', '.config', '.adhd/agent-mcp', '.adhd/tmp/srt', '.adhd/backlog/production/data', '.adhd/backlog/production/backups', 'work']) {
    mkdirSync(join(home, d), { recursive: true });
  }
  writeFileSync(join(home, '.zshrc'), '');
});

afterEach(() => {
  removeRunSrtPolicy();
  rmSync(dir, { recursive: true, force: true });
});

const DENY = () => [join(home, '.npmrc'), join(home, '.ssh'), join(home, '.aws')];
const validate = (entries: string[], opts = {}) => validateSrtExtraAllowWrite(entries, home, DENY(), opts);

describe('515a2b50 AC7.3 validateSrtExtraAllowWrite (fail loud, allowlist)', () => {
  it('accepts a strict descendant of ~/.adhd/backlog and returns the resolved absolute path', () => {
    expect(validate(['~/.adhd/backlog/production/data'])).toEqual([join(home, '.adhd', 'backlog', 'production', 'data')]);
    expect(validate(['~/.adhd/backlog/test/data', join(home, '.adhd/backlog/test/data')])).toEqual([join(home, '.adhd', 'backlog', 'test', 'data')]);
  });

  it('accepts an entry inside an operator-declared trust root, rejects it without the root', () => {
    expect(validate(['~/work/store'], { extraRoots: ['~/work'] })).toEqual([join(home, 'work', 'store')]);
    expect(() => validate(['~/work/store'])).toThrow(SrtPolicyConfigError);
  });

  it.each([
    ['empty string', ''],
    ['NUL byte', '~/.adhd/backlog/x\0y'],
    ['relative path', 'adhd/backlog'],
    ['bare ~user form', '~root/x'],
    ['outside home', '/etc'],
    ['outside home (sibling prefix)', '/home/u2/x'],
    ['$HOME itself', '~'],
    ['ancestor of home', '/'],
    ['~/.adhd itself', '~/.adhd'],
    ['~/.adhd/other (not backlog)', '~/.adhd/other'],
    ['the backlog root itself (too broad)', '~/.adhd/backlog'],
    ['production dir (contains config.yaml)', '~/.adhd/backlog/production'],
    ['backlog config.yaml', '~/.adhd/backlog/production/config.yaml'],
    ['inside backups', '~/.adhd/backlog/production/backups/x'],
    ['~/.ssh', '~/.ssh'],
    ['inside ~/.ssh', '~/.ssh/keys'],
    ['~/.zshrc', '~/.zshrc'],
    ['~/.bashrc', '~/.bashrc'],
    ['~/.claude', '~/.claude'],
    ['inside ~/.claude', '~/.claude/hooks'],
    ['~/.gnupg', '~/.gnupg'],
    ['~/.config', '~/.config'],
    ['inside ~/.config', '~/.config/gh/hosts.yml'],
    ['~/Library/LaunchAgents', '~/Library/LaunchAgents'],
    ['~/.srt-settings.json', '~/.srt-settings.json'],
    ['~/.adhd/agent-mcp', '~/.adhd/agent-mcp'],
    ['inside ~/.adhd/agent-mcp', '~/.adhd/agent-mcp/agents.db'],
    ['the run-policy tree ~/.adhd/tmp', '~/.adhd/tmp'],
    ['inside ~/.adhd/tmp/srt', '~/.adhd/tmp/srt/run-1.json'],
    ['a denyRead file', '~/.npmrc'],
    ['inside a denyRead dir', '~/.aws/sso'],
    ['unrelated dir under home', '~/work/scratch'],
    ['.. segment', '~/.adhd/backlog/../agent-mcp'],
    ['.. escaping home', '~/../../etc'],
    ['glob *', '~/.adhd/backlog/*'],
    ['glob ?', '~/.adhd/backlog/back?og'],
    ['glob []', '~/.adhd/backlog/[b]acklog'],
    ['glob {}', '~/.adhd/backlog/{a,b}'],
  ])('rejects %s', (_label, entry) => {
    expect(() => validate([entry])).toThrow(SrtPolicyConfigError);
  });

  it('error message names the key and the offending entry', () => {
    expect(() => validate(['~/.ssh'])).toThrow(/agent\.shell\.sandbox\.extraAllowWrite.*~\/\.ssh/);
  });

  it('one bad entry rejects the whole list (never silently dropped)', () => {
    expect(() => validate(['~/.adhd/backlog/production/data', '/etc'])).toThrow(SrtPolicyConfigError);
  });

  it('a trust root may not be ~/.adhd, an ancestor, or itself protected', () => {
    expect(() => validate(['~/.adhd/x'], { extraRoots: ['~/.adhd'] })).toThrow(/trust root|protected/);
    expect(() => validate(['~/.ssh/x'], { extraRoots: ['~/.ssh'] })).toThrow(SrtPolicyConfigError);
    expect(() => validate(['~/x'], { extraRoots: ['~'] })).toThrow(SrtPolicyConfigError);
  });

  it('protectedPaths (e.g. the resolved run-policy dir) are refused even inside a trust root', () => {
    const policyDir = join(home, 'work', 'policies');
    expect(() => validate([join(policyDir, 'run')], { extraRoots: ['~/work'], protectedPaths: [policyDir] })).toThrow(SrtPolicyConfigError);
  });

  describe('515a2b50 SEC-F5 realpath + case-fold + NFC', () => {
    it.each([
      ['~/.SSH', '~/.SSH'],
      ['~/.ADHD/agent-mcp', '~/.ADHD/agent-mcp'],
      ['~/.Adhd/TMP/srt', '~/.Adhd/TMP/srt'],
      ['~/.CLAUDE', '~/.CLAUDE'],
    ])('rejects the case variant %s', (_label, entry) => {
      expect(() => validate([entry])).toThrow(SrtPolicyConfigError);
    });

    it('rejects an entry that is a SYMLINK into a protected dir', () => {
      symlinkSync(join(home, '.ssh'), join(home, '.adhd', 'backlog', 'link-to-ssh'));
      expect(() => validate(['~/.adhd/backlog/link-to-ssh'])).toThrow(SrtPolicyConfigError);
    });

    it('rejects an entry whose PARENT is a symlink into a protected dir (leaf does not exist yet)', () => {
      symlinkSync(join(home, '.claude'), join(home, '.adhd', 'backlog', 'via'));
      expect(() => validate(['~/.adhd/backlog/via/not-yet'])).toThrow(SrtPolicyConfigError);
    });

    it('rejects a symlink inside the backlog tree that escapes the allowlist root', () => {
      symlinkSync(join(home, 'work'), join(home, '.adhd', 'backlog', 'escape'));
      expect(() => validate(['~/.adhd/backlog/escape/data'])).toThrow(SrtPolicyConfigError);
    });

    it('emits the symlink-RESOLVED path (what srt enforces), not the lexical one', () => {
      mkdirSync(join(home, 'work', 'real-data'));
      symlinkSync(join(home, 'work', 'real-data'), join(home, '.adhd', 'backlog', 'prod-link'));
      // The link lies inside the backlog tree but resolves outside it: refused (allowlist on real path).
      expect(() => validate(['~/.adhd/backlog/prod-link'])).toThrow(SrtPolicyConfigError);
      // ... unless the operator declared the resolved location a trust root.
      expect(validate(['~/.adhd/backlog/prod-link'], { extraRoots: ['~/work'] })).toEqual([join(home, 'work', 'real-data')]);
    });

    it('compares NFC-normalized: an NFD spelling of a protected path is the same path', () => {
      const protectedNfc = join(home, '.adhd', 'backlog', 'prod', 'café');
      const entryNfd = '~/.adhd/backlog/prod/café/inner';
      expect(() => validate([entryNfd], { protectedPaths: [protectedNfc] })).toThrow(SrtPolicyConfigError);
      expect(validate([entryNfd])).toHaveLength(1); // control: only the protected list blocks it
    });

    it('a unicode lookalike of the backlog root is NOT inside the allowlist', () => {
      // Cyrillic U+0430 in ".adhd" -> a different directory, not ~/.adhd/backlog.
      expect(() => validate(['~/.аdhd/backlog/production/data'])).toThrow(SrtPolicyConfigError);
    });

    it('resolveRealPrefix resolves the longest existing prefix and keeps the missing tail', () => {
      symlinkSync(join(home, 'work'), join(home, 'wl'));
      expect(resolveRealPrefix(join(home, 'wl', 'a', 'b'))).toBe(join(home, 'work', 'a', 'b'));
    });
  });
});

describe('515a2b50 SEC-F1/F3 shipped defaults', () => {
  it('default is exactly the production DATA dir; denyWrite covers config.yaml and backups', () => {
    expect([...DEFAULT_SRT_EXTRA_ALLOW_WRITE]).toEqual(['~/.adhd/backlog/production/data']);
    expect([...DEFAULT_SRT_BACKLOG_DENY_WRITE]).toEqual([
      '~/.adhd/backlog/production/config.yaml',
      '~/.adhd/backlog/production/backups',
    ]);
    expect(defaultSrtDenyWrite(home)).toEqual([
      join(home, '.adhd/backlog/production/config.yaml'),
      join(home, '.adhd/backlog/production/backups'),
    ]);
    expect(validate([...DEFAULT_SRT_EXTRA_ALLOW_WRITE])).toEqual([join(home, '.adhd/backlog/production/data')]);
  });

  it('SEC-F3: a PROJECT-scope config.yaml cannot change the key (read via the scope-pinned operationalEnv)', async () => {
    const project = join(dir, 'proj');
    const cfgDir = join(project, '.adhd', 'agent-mcp', 'production');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.yaml'), 'agent:\n  shell:\n    sandbox:\n      extraAllowWrite:\n        - "~/.zshrc"\n      extraAllowWriteRoots:\n        - "~/.claude"\n');
    const prevScope = process.env['ADHD_ENV_SCOPE'];
    const prevCwd = process.cwd();
    process.env['ADHD_ENV_SCOPE'] = 'project';
    try {
      process.chdir(project);
      vi.resetModules();
      const config = await import('../config.js');
      const srt = await import('../srt-policy.js');
      // Positive control (teeth): the hole is real on the unpinned instance...
      expect(config.env.config.agent.shell.sandbox.extraAllowWrite).toEqual(['~/.zshrc']);
      // ... and closed on the pinned one the sandbox reads.
      expect(config.operationalEnv.config.agent.shell.sandbox.extraAllowWrite).toEqual(['~/.adhd/backlog/production/data']);
      expect(config.operationalEnv.config.agent.shell.sandbox.extraAllowWriteRoots).toEqual([]);
      expect(srt.resolveSrtExtraAllowWrite()).toEqual([join(srt.resolveRealPrefix(homedir()), '.adhd', 'backlog', 'production', 'data')]);
    } finally {
      process.chdir(prevCwd);
      if (prevScope === undefined) delete process.env['ADHD_ENV_SCOPE'];
      else process.env['ADHD_ENV_SCOPE'] = prevScope;
      vi.resetModules();
    }
  });
});

describe('515a2b50 AC7.3 rendered policy golden', () => {
  const opts = (settingsPath: string, extra: Record<string, unknown> = {}) => ({
    settingsPath,
    ...extra,
  });
  /** Resolve the default extras against the scratch HOME (homedir() reads $HOME). */
  function withHome<T>(fn: () => T): T {
    const prev = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prev;
    }
  }
  const read = (p: string) =>
    JSON.parse(readFileSync(p, 'utf8')) as {
      filesystem: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] };
      adhdManaged?: { extraAllowWrite: string[]; denyWrite: string[] };
    };

  it('run policy: allowWrite = static caches + the production data dir (+ the cwd); denyWrite = config.yaml + backups', () => {
    const settingsPath = join(dir, 'policy.json');
    withHome(() => provisionSrtPolicy(opts(settingsPath, { allowWrite: ['/work/cwd'], applySandboxExtras: true })));
    const written = read(settingsPath);
    const data = join(home, '.adhd', 'backlog', 'production', 'data');
    expect(written.filesystem.allowWrite).toEqual([...withHome(defaultSrtAllowWrite), data, '/work/cwd']);
    expect(written.filesystem.denyRead).toEqual(withHome(defaultSrtDenyRead));
    expect(written.filesystem.denyWrite).toEqual(defaultSrtDenyWrite(home));
    // least privilege: nothing broader than the data dir under ~/.adhd, and never $HOME.
    expect(written.filesystem.allowWrite).not.toContain(join(home, '.adhd'));
    expect(written.filesystem.allowWrite).not.toContain(join(home, '.adhd', 'backlog'));
    expect(written.filesystem.allowWrite).not.toContain(home);
  });

  it('SEC-F7: the GLOBAL static file never receives the sandbox extras', () => {
    const settingsPath = join(dir, 'global.json');
    withHome(() => provisionSrtPolicy({ settingsPath }));
    const written = read(settingsPath);
    expect(written.filesystem.allowWrite).toEqual(withHome(defaultSrtAllowWrite));
    expect(written.filesystem.denyWrite).toEqual([]);
    expect(written.adhdManaged).toBeUndefined();
  });

  it('SEC-F7: narrowing the config removes the earlier extra on the next provision; operator entries survive', () => {
    const settingsPath = join(dir, 'narrow.json');
    writeFileSync(settingsPath, JSON.stringify({ filesystem: { allowWrite: ['/operator/own'], denyWrite: ['/operator/deny'] } }));
    withHome(() => provisionSrtPolicy(opts(settingsPath, { applySandboxExtras: true })));
    expect(read(settingsPath).filesystem.allowWrite).toContain(join(home, '.adhd', 'backlog', 'production', 'data'));
    withHome(() => provisionSrtPolicy(opts(settingsPath, { applySandboxExtras: true, extraAllowWrite: [] })));
    const narrowed = read(settingsPath);
    expect(narrowed.filesystem.allowWrite).not.toContain(join(home, '.adhd', 'backlog', 'production', 'data'));
    expect(narrowed.filesystem.allowWrite).toContain('/operator/own');
    expect(narrowed.filesystem.denyWrite).toContain('/operator/deny');
    // Removing the sandbox extras entirely (global-style provision) also drops them.
    withHome(() => provisionSrtPolicy(opts(settingsPath, { applySandboxExtras: true })));
    withHome(() => provisionSrtPolicy({ settingsPath }));
    const dropped = read(settingsPath);
    expect(dropped.filesystem.allowWrite).not.toContain(join(home, '.adhd', 'backlog', 'production', 'data'));
    expect(dropped.filesystem.denyWrite).toEqual(['/operator/deny']);
    expect(dropped.adhdManaged).toBeUndefined();
  });

  it('SEC-F7: provisionRunSrtPolicy rebuilds an owned per-run file from scratch (a stale broader allow cannot survive)', () => {
    const roots = { temp: join(dir, 'temp') };
    const path = join(srtRunPolicyDir(roots), `run-${process.pid}.json`);
    mkdirSync(srtRunPolicyDir(roots), { recursive: true });
    writeFileSync(path, JSON.stringify({ filesystem: { allowWrite: ['/stale/broad'] } }));
    withHome(() => provisionRunSrtPolicy('/work/cwd', {} as NodeJS.ProcessEnv, roots));
    expect(read(path).filesystem.allowWrite).not.toContain('/stale/broad');
  });

  it('extraAllowWrite: [] renders no backlog allow (the key is load-bearing)', () => {
    const settingsPath = join(dir, 'policy-empty.json');
    withHome(() => provisionSrtPolicy(opts(settingsPath, { applySandboxExtras: true, extraAllowWrite: [] })));
    expect(read(settingsPath).filesystem.allowWrite).toEqual(withHome(defaultSrtAllowWrite));
  });

  it('an invalid extra root throws before anything is written', () => {
    const settingsPath = join(dir, 'policy-bad.json');
    expect(() => withHome(() => provisionSrtPolicy(opts(settingsPath, { applySandboxExtras: true, extraAllowWrite: ['~/.ssh'] })))).toThrow(SrtPolicyConfigError);
    expect(() => statSync(settingsPath)).toThrow();
  });

  it('the per-run policy file is mode 0600 inside the run-policy temp dir; new parent dirs are 0700', () => {
    const roots = { temp: join(dir, 'fresh', 'temp') };
    const result = withHome(() => provisionRunSrtPolicy('/work/cwd', {} as NodeJS.ProcessEnv, roots));
    expect(result.path).toBe(join(srtRunPolicyDir(roots), `run-${process.pid}.json`));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(srtRunPolicyDir(roots)).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'fresh', 'temp')).mode & 0o777).toBe(0o700);
  });

  it('re-provisioning an existing wider-mode file tightens it back to 0600', () => {
    const settingsPath = join(dir, 'policy-mode.json');
    withHome(() => provisionSrtPolicy({ settingsPath }));
    chmodSync(settingsPath, 0o644);
    withHome(() => provisionSrtPolicy({ settingsPath, allowWrite: ['/new/root'] })); // content change => rewrite
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it('SEC-F8: a symlink pre-planted at the tmp policy name is replaced, never written through', () => {
    const settingsPath = join(dir, 'policy-plant.json');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'KEEP');
    const now = 1_800_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      symlinkSync(victim, `${settingsPath}.tmp-${process.pid}-${now}`);
      withHome(() => provisionSrtPolicy({ settingsPath }));
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(victim, 'utf8')).toBe('KEEP');
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(read(settingsPath).filesystem.allowWrite).toEqual(withHome(defaultSrtAllowWrite));
  });
});
