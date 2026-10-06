/**
 * NAT-TOOL-4 — `srt` policy provisioning (ADR-0008 D7; deferral a5a2f1d4).
 *
 * `resolveNativeTooling` wraps the builtins with `srt` by default, and `srt`
 * reads `~/.srt-settings.json` (default-deny when absent). Without a policy the
 * wrapped servers cannot reach their caches/registries and fail to spawn. These
 * tests pin the provisioning contract: additive/non-destructive, idempotent,
 * and seeded with the adopted servers' cache + registry allow-list.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SRT_ALLOWED_DOMAINS,
  SRT_SETTINGS_ENV,
  defaultSrtAllowWrite,
  ensureBinDirOnPath,
  getSrtRunSettingsPath,
  isSrtPolicyProvisioned,
  provisionRunSrtPolicy,
  provisionSrtPolicy,
  removeRunSrtPolicy,
  resolveNativeBinDir,
  resolveSrtRunSettingsPath,
  resolveSrtSettingsPath,
} from '../srt-policy.js';
import { withResolvedNativeTooling } from '../defaults.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LOCK_HOLDER = fileURLToPath(new URL('./fixtures/srt-lock-holder.cjs', import.meta.url));

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface SrtShape {
  filesystem?: { allowWrite?: string[]; allowRead?: string[]; denyWrite?: string[]; denyRead?: string[] };
  network?: { allowedDomains?: string[]; deniedDomains?: string[] };
  custom?: { kept?: boolean };
}

describe('provisionSrtPolicy (a5a2f1d4)', () => {
  let dir = '';
  let settingsPath = '';

  beforeEach(async () => {
    const root = join(REPO_ROOT, 'tmp', 'agent-mcp');
    await mkdir(root, { recursive: true });
    dir = await mkdtemp(join(root, 'srt-policy-'));
    settingsPath = join(dir, '.srt-settings.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a policy seeded with the adopted servers\' cache + registry allow-list', async () => {
    const result = provisionSrtPolicy({ settingsPath, allowWrite: ['/work/root'] });
    expect(result.created).toBe(true);
    expect(result.updated).toBe(true);

    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as SrtShape;
    expect(written.filesystem?.allowWrite).toContain('/work/root');
    // uv + npm caches must be writable for `uvx`/`npx` to initialize.
    expect(written.filesystem?.allowWrite?.some((p) => /\.cache[/\\]uv$/.test(p) || /\.npm$/.test(p))).toBe(
      true
    );
    // PyPI (uvx) + npm registry (npx) must be reachable.
    for (const domain of DEFAULT_SRT_ALLOWED_DOMAINS) {
      expect(written.network?.allowedDomains).toContain(domain);
    }
    expect(isSrtPolicyProvisioned(settingsPath)).toBe(true);
  });

  it('is ADDITIVE and non-destructive: existing rules are preserved, allow-lists unioned', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        filesystem: {
          denyRead: ['/secret'],
          allowRead: ['/readable'],
          allowWrite: ['/existing'],
          denyWrite: ['/protected'],
        },
        network: { allowedDomains: ['example.com'], deniedDomains: ['evil.example'] },
        custom: { kept: true },
      }),
      'utf8'
    );

    const result = provisionSrtPolicy({ settingsPath, allowWrite: ['/work/root'] });
    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as SrtShape;

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(written.filesystem?.denyRead).toContain('/secret');
    expect(written.filesystem?.allowRead).toContain('/readable');
    expect(written.filesystem?.allowWrite).toContain('/existing');
    expect(written.filesystem?.allowWrite).toContain('/work/root');
    expect(written.filesystem?.denyWrite).toContain('/protected');
    expect(written.network?.allowedDomains).toContain('example.com');
    expect(written.network?.deniedDomains).toContain('evil.example');
    expect(written.custom).toEqual({ kept: true }); // unknown keys carried through
  });

  it('is idempotent: a second provision yields byte-identical content', async () => {
    provisionSrtPolicy({ settingsPath, allowWrite: ['/work/root'] });
    const first = await readFile(settingsPath, 'utf8');
    const second = provisionSrtPolicy({ settingsPath, allowWrite: ['/work/root'] });
    expect(second.updated).toBe(false);
    expect(await readFile(settingsPath, 'utf8')).toBe(first);
  });

  it('resolveSrtSettingsPath honors ADHD_AGENT_SRT_SETTINGS', () => {
    expect(resolveSrtSettingsPath({ [SRT_SETTINGS_ENV]: '/custom/srt.json' } as NodeJS.ProcessEnv)).toBe(
      '/custom/srt.json'
    );
  });
});

describe('A3 — static, unconditional allow-list (535c1101)', () => {
  it('includes ~/.local/share, ~/.cache and ~/Library/Caches; drops /private/tmp', () => {
    const roots = defaultSrtAllowWrite();
    const home = homedir();
    expect(roots).toContain(join(home, '.local', 'share'));
    expect(roots).toContain(join(home, '.cache'));
    expect(roots).toContain(join(home, 'Library', 'Caches'));
    expect(roots).not.toContain('/private/tmp');
  });

  it('includes a lazily-created cache root even when it does NOT exist yet (no existsSync gate)', async () => {
    const prevHome = process.env.HOME;
    const base = join(REPO_ROOT, 'tmp', 'agent-mcp');
    await mkdir(base, { recursive: true });
    const fakeHome = await mkdtemp(join(base, 'srt-home-'));
    process.env.HOME = fakeHome;
    try {
      const roots = defaultSrtAllowWrite();
      expect(roots).toContain(join(fakeHome, '.cache', 'uv'));
      expect(roots).toContain(join(fakeHome, '.local', 'share'));
      expect(roots).toContain(join(fakeHome, 'Library', 'Caches'));
      // TEETH: these paths deliberately do not exist — the old existsSync filter dropped them.
      expect(existsSync(join(fakeHome, '.cache', 'uv'))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('A3/A4 — per-run settings file + `srt -s` wiring', () => {
  let dir = '';

  beforeEach(async () => {
    const root = join(REPO_ROOT, 'tmp', 'agent-mcp');
    await mkdir(root, { recursive: true });
    dir = await mkdtemp(join(root, 'srt-run-'));
  });

  afterEach(async () => {
    removeRunSrtPolicy();
    await rm(dir, { recursive: true, force: true });
  });

  it('ADHD_AGENT_SRT_SETTINGS overrides the run path; default is a per-process run-<pid>.json', () => {
    expect(
      resolveSrtRunSettingsPath({ [SRT_SETTINGS_ENV]: '/custom/srt.json' } as NodeJS.ProcessEnv)
    ).toBe('/custom/srt.json');
    const def = resolveSrtRunSettingsPath({} as NodeJS.ProcessEnv);
    expect(def).toMatch(new RegExp(`run-${process.pid}\\.json$`));
  });

  it('A3(a): the per-run file carries the cwd; the static global file does NOT', async () => {
    const globalPath = join(dir, 'global.srt.json');
    const runPath = join(dir, 'run.srt.json');
    provisionSrtPolicy({ settingsPath: globalPath });
    provisionRunSrtPolicy(
      '/some/dispatch/cwd',
      { [SRT_SETTINGS_ENV]: runPath } as NodeJS.ProcessEnv
    );

    const global = JSON.parse(await readFile(globalPath, 'utf8')) as SrtShape;
    const run = JSON.parse(await readFile(runPath, 'utf8')) as SrtShape;
    expect(global.filesystem?.allowWrite ?? []).not.toContain('/some/dispatch/cwd');
    expect(run.filesystem?.allowWrite ?? []).toContain('/some/dispatch/cwd');
    expect(getSrtRunSettingsPath()).toBe(runPath);
  });

  it('AC6: EVERY resolved fs root is unioned into the per-run srt allowWrite (multi-root)', async () => {
    const runPath = join(dir, 'run-multi.srt.json');
    provisionRunSrtPolicy('/host/cwd', {
      [SRT_SETTINGS_ENV]: runPath,
    } as NodeJS.ProcessEnv);

    // Drive the REAL host task-time call site — the store wrapper — not the pure
    // resolver (#11: the union is an explicit host step). Resolve a definition
    // with TWO portable roots at caller cwd /P; the host must union BOTH into
    // the per-run policy, else a read from the second root is sandbox-DENIED.
    const def = { mcpServers: {}, nativeTooling: { fs: { roots: ['a', 'b'] } } };
    const wrapped = withResolvedNativeTooling(
      { read: () => def as never },
      () => ({ cwd: '/P' })
    );
    wrapped.read('a');

    const run = JSON.parse(await readFile(runPath, 'utf8')) as SrtShape;
    expect(run.filesystem?.allowWrite ?? []).toContain('/P/a');
    expect(run.filesystem?.allowWrite ?? []).toContain('/P/b');
  });

  it('#3/#11: a resolved `shell.root` alias is unioned into the per-run srt allowWrite', async () => {
    const runPath = join(dir, 'run-shell.srt.json');
    provisionRunSrtPolicy('/host/cwd', {
      [SRT_SETTINGS_ENV]: runPath,
    } as NodeJS.ProcessEnv);

    // `shell.root` is now the SAME portable-hint contract as `fs.root` (#3), so
    // an alias outside the dispatching cwd becomes the shell's cwd — and must be
    // in the srt policy or the srt-wrapped shell is DENIED its own cwd.
    const def = { mcpServers: {}, nativeTooling: { shell: { root: 'project' } } };
    const wrapped = withResolvedNativeTooling(
      { read: () => def as never },
      () => ({ cwd: '/P', roots: { project: '/opt/proj' } })
    );
    wrapped.read('a');

    const run = JSON.parse(await readFile(runPath, 'utf8')) as SrtShape;
    expect(run.filesystem?.allowWrite ?? []).toContain('/opt/proj');
    // Teeth: the un-resolved alias name is NOT what lands in the policy.
    expect(run.filesystem?.allowWrite ?? []).not.toContain('/P/project');
  });

  it('removeRunSrtPolicy removes the file WE created', async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = dir; // isolate the default per-pid path under the temp dir
    try {
      const result = provisionRunSrtPolicy('/work');
      expect(existsSync(result.path)).toBe(true);
      removeRunSrtPolicy();
      expect(existsSync(result.path)).toBe(false);
      expect(getSrtRunSettingsPath()).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it('A3: concurrent provisioners do NOT lose a concurrent write (lock; ADR-0012)', async () => {
    const settingsPath = join(dir, 'concurrent.srt.json');
    const ready = `${settingsPath}.ready`;
    const go = `${settingsPath}.go`;
    const child = spawn(process.execPath, [LOCK_HOLDER, JSON.stringify({ settingsPath })], {
      stdio: 'ignore',
    });
    try {
      await waitFor(() => existsSync(ready), 5000);
      writeFileSync(go, '1');
      // Must WAIT for the holder's lock, then read the holder's file and merge.
      provisionSrtPolicy({ settingsPath, allowWrite: ['/main'] });
      const written = JSON.parse(await readFile(settingsPath, 'utf8')) as SrtShape;
      expect(written.filesystem?.allowWrite ?? []).toContain('/child'); // holder's rule survived
      expect(written.filesystem?.allowWrite ?? []).toContain('/main'); // ours survived
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('srt bin resolution (PATH provisioning)', () => {
  it('resolveNativeBinDir finds the repo node_modules/.bin (srt/uvx live there)', () => {
    const bin = resolveNativeBinDir();
    expect(bin).toBeDefined();
    expect(bin).toMatch(/node_modules[/\\]\.bin$/);
  });

  it('ensureBinDirOnPath prepends the bin dir exactly once', () => {
    const once = ensureBinDirOnPath('/usr/bin', '/repo/node_modules/.bin');
    expect(once).toBe(`/repo/node_modules/.bin${process.platform === 'win32' ? ';' : ':'}/usr/bin`);
    const twice = ensureBinDirOnPath(once, '/repo/node_modules/.bin');
    expect(twice).toBe(once);
  });

  it('ensureBinDirOnPath leaves the value untouched when no bin dir is known', () => {
    expect(ensureBinDirOnPath('/usr/bin', undefined)).toBe('/usr/bin');
  });
});
