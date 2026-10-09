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
const validate = (d: string, trustRoots: readonly string[] = []) =>
  validateSrtSpillReadDir(d, home, DENY(), {
    tempRoot: temp,
    protectedPaths: [join(temp, 'srt'), join(home, '.srt-settings.json')],
    trustRoots,
  });
const read = (p: string) =>
  JSON.parse(readFileSync(p, 'utf8')) as { filesystem: { allowRead: string[]; allowWrite: string[] }; adhdManaged?: Record<string, string[]> };

describe('9ed453c1 BK9 AC9.4 validateSrtSpillReadDir (fail loud)', () => {
  it('accepts the default <temp>/tool-results and returns the resolved path', () => {
    expect(validate(join(temp, 'tool-results'))).toBe(join(temp, 'tool-results'));
    expect(validate('~/work/spill', ['~/work'])).toBe(join(home, 'work', 'spill'));
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

describe('9ed453c1 HARD-H3 validateSrtSpillReadDir is an allowlist (agent-mcp data/DB/logs never read-allowed)', () => {
  const agentMcpHome = () => join(home, '.adhd', 'agent-mcp');
  beforeEach(() => {
    for (const d of ['production/data', 'production/logs', 'production/temp/tool-results/run-1']) {
      mkdirSync(join(agentMcpHome(), d), { recursive: true });
    }
  });

  it('accepts only the <temp>/tool-results subtree under the agent-mcp prefix (itself and descendants)', () => {
    const spill = join(temp, 'tool-results');
    expect(validate(spill)).toBe(spill);
    expect(validate(join(spill, 'run-1'))).toBe(join(spill, 'run-1'));
  });

  it.each([
    ['the agent-mcp data dir (holds the agent DB)', () => join(agentMcpHome(), 'production', 'data')],
    ['a dir inside the data dir', () => join(agentMcpHome(), 'production', 'data', 'spill')],
    ['the agent-mcp logs dir', () => join(agentMcpHome(), 'production', 'logs')],
    ['the agent-mcp home itself', () => agentMcpHome()],
    ['the env root above temp/data/logs', () => join(agentMcpHome(), 'production')],
    ['a sibling of tool-results under the temp root', () => join(temp, 'scratch')],
    ['the run-policy dir', () => join(temp, 'srt')],
    ['an arbitrary non-allowlisted home dir (no trust root declared)', () => join(home, 'work', 'spill')],
  ])('rejects %s', (_label, make) => {
    expect(() => validate(make())).toThrow(SrtPolicyConfigError);
  });

  it('rejects a tool-results SYMLINK that points at the data dir (resolves outside the subtree)', () => {
    rmSync(join(temp, 'tool-results'), { recursive: true, force: true });
    symlinkSync(join(agentMcpHome(), 'production', 'data'), join(temp, 'tool-results'));
    expect(() => validate(join(temp, 'tool-results'))).toThrow(SrtPolicyConfigError);
    expect(() => validate(join(temp, 'tool-results', 'x'))).toThrow(SrtPolicyConfigError);
  });

  it('rejects a path under tool-results that is a symlink into the data dir', () => {
    symlinkSync(join(agentMcpHome(), 'production', 'data'), join(temp, 'tool-results', 'sneaky'));
    expect(() => validate(join(temp, 'tool-results', 'sneaky'))).toThrow(SrtPolicyConfigError);
  });

  it('provisioning with spillReadDir = the data dir (holding the agent DB) aborts and writes nothing', () => {
    const path = join(dir, 'data-dir.json');
    const dataDir = join(agentMcpHome(), 'production', 'data');
    const prev = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      expect(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: dataDir, spillTempRoot: temp })).toThrow(
        SrtPolicyConfigError
      );
    } finally {
      if (prev === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prev;
    }
  });

  it('without a tempRoot nothing under the agent-mcp prefix is accepted', () => {
    expect(() => validateSrtSpillReadDir(join(temp, 'tool-results'), home, DENY())).toThrow(SrtPolicyConfigError);
  });

  it('operator trust roots admit their subtree but can never admit the agent-mcp data dir or ~/.adhd', () => {
    expect(validate('~/work/spill', ['~/work'])).toBe(join(home, 'work', 'spill'));
    expect(() => validate(join(agentMcpHome(), 'production', 'data'), ['~/work'])).toThrow(SrtPolicyConfigError);
    expect(() => validate(join(agentMcpHome(), 'production', 'data'), ['~/.adhd'])).toThrow(SrtPolicyConfigError);
    expect(() => validate(join(agentMcpHome(), 'production', 'data'), [agentMcpHome()])).toThrow(SrtPolicyConfigError);
    expect(() => validate('~/work/spill', ['~'])).toThrow(SrtPolicyConfigError);
    expect(() => validate('~/work/spill', ['~/.ssh'])).toThrow(SrtPolicyConfigError);
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
    withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: spillDir(), spillTempRoot: temp, allowWrite: ['/work/cwd'] }));
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
    withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: spillDir(), spillTempRoot: temp, allowRead: ['/opt/operator-read'] }));
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
    expect(() => withHome(() => provisionSrtPolicy({ settingsPath: path, applySandboxExtras: true, spillReadDir: join(home, '.ssh'), spillTempRoot: temp }))).toThrow(
      SrtPolicyConfigError
    );
  });

  it('config-driven default: ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED=true renders the resolved dir; unset renders none', async () => {
    const prevEnabled = process.env['ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED'];
    const prevDir = process.env['ADHD_AGENT_TOOL_RESULT_SPILL_DIR'];
    try {
      delete process.env['ADHD_AGENT_TOOL_RESULT_SPILL_DIR'];
      process.env['ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED'] = 'true';
      vi.resetModules();
      let srt = await import('../srt-policy.js');
      const { resolveLogRoots: liveRoots } = await import('../config.js');
      const onPath = join(dir, 'cfg-on.json');
      srt.provisionSrtPolicy({ settingsPath: onPath, applySandboxExtras: true });
      expect(read(onPath).filesystem.allowRead).toEqual([join(liveRoots().temp, 'tool-results')]);

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
