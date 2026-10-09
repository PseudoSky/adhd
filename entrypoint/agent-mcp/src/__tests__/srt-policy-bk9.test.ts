/**
 * BK9 (backlog 3ad735bb, plan 9ed453c1) — pure unit tests for how the srt policy treats the tool-result
 * spill directory: READ-allowed only when spill is enabled, never written to `allowWrite`, never in the
 * shared global file, never an unsafe location. The real-srt proof is `srt-policy-bk9.e2e.test.ts`
 * (ADR-0009 e2e lane).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SrtPolicyConfigError, provisionSrtPolicy, validateSrtSpillReadDir } from '../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRATCH = join(REPO_ROOT, 'tmp', 'agent-mcp');

let dir = '';
let home = '';
let temp = '';

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(join(SCRATCH, 'srt-bk9u-'));
  home = realpathSync(join(dir, (mkdirSync(join(dir, 'home')), 'home')));
  for (const d of ['.ssh', '.claude', '.config', '.adhd/agent-mcp/production/temp/srt', 'work']) {
    mkdirSync(join(home, d), { recursive: true });
  }
  temp = join(home, '.adhd/agent-mcp/production/temp');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DENY = () => [join(home, '.npmrc'), join(home, '.ssh'), join(home, '.aws')];
const validate = (d: string) =>
  validateSrtSpillReadDir(d, home, DENY(), { tempRoot: temp, protectedPaths: [join(temp, 'srt'), join(home, '.srt-settings.json')] });
const read = (p: string) =>
  JSON.parse(readFileSync(p, 'utf8')) as { filesystem: { allowRead: string[]; allowWrite: string[] }; adhdManaged?: Record<string, string[]> };

describe('9ed453c1 BK9 AC9.4 validateSrtSpillReadDir (fail loud)', () => {
  it('accepts the default <temp>/tool-results and returns the resolved path', () => {
    expect(validate(join(temp, 'tool-results'))).toBe(join(temp, 'tool-results'));
    expect(validate('~/work/spill')).toBe(join(home, 'work', 'spill'));
  });

  it.each([
    ['$HOME', () => home],
    ['an ancestor of $HOME', () => dir],
    ['the agent-mcp temp root (credential-bearing scratch)', () => temp],
    ['an ancestor of the temp root', () => join(home, '.adhd')],
    ['the run-policy dir', () => join(temp, 'srt')],
    ['inside the run-policy dir', () => join(temp, 'srt', 'x')],
    ['~/.ssh', () => join(home, '.ssh')],
    ['inside ~/.ssh', () => join(home, '.ssh', 'spill')],
    ['inside ~/.claude', () => join(home, '.claude', 'spill')],
    ['~/.config', () => join(home, '.config')],
    ['a denyRead file', () => join(home, '.npmrc')],
    ['relative', () => 'spill'],
    ['a .. segment', () => join(home, 'work', '..', '.ssh')],
    ['a glob', () => join(home, 'work', '*')],
  ])('rejects %s', (_label, make) => {
    expect(() => validate(make())).toThrow(SrtPolicyConfigError);
  });

  it('rejects a path that is a SYMLINK into a protected dir', () => {
    symlinkSync(join(home, '.ssh'), join(home, 'work', 'sneaky'));
    expect(() => validate(join(home, 'work', 'sneaky'))).toThrow(SrtPolicyConfigError);
    expect(() => validate(join(home, 'work', 'sneaky', 'child'))).toThrow(SrtPolicyConfigError);
  });

  it('rejects a case variant of a protected dir', () => {
    expect(() => validate(join(home, '.SSH'))).toThrow(SrtPolicyConfigError);
  });
});

describe('9ed453c1 BK9 AC9.4 rendered policy: allowRead only when spill is enabled; writes never widened', () => {
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
  const spillDir = () => join(temp, 'tool-results');

  it('spillReadDir given: the dir is in allowRead and NOT in allowWrite; tracked under adhdManaged', () => {
    const path = join(dir, 'on.json');
    withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: spillDir(), allowWrite: ['/work/cwd'] }));
    const s = read(path);
    expect(s.filesystem.allowRead).toEqual([spillDir()]);
    expect(s.filesystem.allowWrite).not.toContain(spillDir());
    expect(s.filesystem.allowWrite.some((w) => spillDir().startsWith(`${w}/`) && w !== '/work/cwd')).toBe(false);
    expect(s.adhdManaged?.['allowRead']).toEqual([spillDir()]);
  });

  it('spillReadDir null (spill off): allowRead is empty and adhdManaged carries no allowRead', () => {
    const path = join(dir, 'off.json');
    withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: null }));
    const s = read(path);
    expect(s.filesystem.allowRead).toEqual([]);
    expect(s.adhdManaged?.['allowRead']).toBeUndefined();
  });

  it('turning spill OFF on a re-provision removes the managed read allow but keeps operator-authored allowRead', () => {
    const path = join(dir, 'toggle.json');
    withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: spillDir(), allowRead: ['/opt/operator-read'] }));
    expect(read(path).filesystem.allowRead.sort()).toEqual(['/opt/operator-read', spillDir()].sort());
    withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: null }));
    expect(read(path).filesystem.allowRead).toEqual(['/opt/operator-read']);
  });

  it('the shared GLOBAL file (no applySandboxExtras) never receives the spill read allow', () => {
    const path = join(dir, 'global.json');
    withHome(() => provisionSrtPolicy({ settingsPath: path, spillReadDir: spillDir() }));
    expect(read(path).filesystem.allowRead).toEqual([]);
  });

  it('an unsafe spillReadDir aborts the provision (fail loud, nothing written)', () => {
    const path = join(dir, 'bad.json');
    expect(() => withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: join(home, '.ssh') }))).toThrow(
      SrtPolicyConfigError
    );
  });

  it('config-driven default: ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED=true renders the resolved dir; unset renders none', async () => {
    const prevEnabled = process.env['ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED'];
    const prevDir = process.env['ADHD_AGENT_TOOL_RESULT_SPILL_DIR'];
    try {
      process.env['ADHD_AGENT_TOOL_RESULT_SPILL_DIR'] = join(dir, 'cfg-spill');
      process.env['ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED'] = 'true';
      vi.resetModules();
      let srt = await import('../srt-policy.js');
      const onPath = join(dir, 'cfg-on.json');
      srt.provisionSrtPolicy({ settingsPath: onPath, applySandboxExtras: true });
      expect(read(onPath).filesystem.allowRead).toEqual([join(realpathSync(dir), 'cfg-spill')]);

      delete process.env['ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED'];
      vi.resetModules();
      srt = await import('../srt-policy.js');
      const offPath = join(dir, 'cfg-off.json');
      srt.provisionSrtPolicy({ settingsPath: offPath, applySandboxExtras: true });
      expect(read(offPath).filesystem.allowRead).toEqual([]);
    } finally {
      if (prevEnabled === undefined) delete process.env['ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED'];
      else process.env['ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED'] = prevEnabled;
      if (prevDir === undefined) delete process.env['ADHD_AGENT_TOOL_RESULT_SPILL_DIR'];
      else process.env['ADHD_AGENT_TOOL_RESULT_SPILL_DIR'] = prevDir;
      vi.resetModules();
    }
  });
});
