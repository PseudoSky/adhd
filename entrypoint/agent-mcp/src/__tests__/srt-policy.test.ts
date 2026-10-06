/**
 * NAT-TOOL-4 — `srt` policy provisioning (ADR-0008 D7; deferral a5a2f1d4).
 *
 * `resolveNativeTooling` wraps the builtins with `srt` by default, and `srt`
 * reads `~/.srt-settings.json` (default-deny when absent). Without a policy the
 * wrapped servers cannot reach their caches/registries and fail to spawn. These
 * tests pin the provisioning contract: additive/non-destructive, idempotent,
 * and seeded with the adopted servers' cache + registry allow-list.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SRT_ALLOWED_DOMAINS,
  SRT_SETTINGS_ENV,
  ensureBinDirOnPath,
  isSrtPolicyProvisioned,
  provisionSrtPolicy,
  resolveNativeBinDir,
  resolveSrtSettingsPath,
} from '../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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
