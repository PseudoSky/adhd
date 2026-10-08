/**
 * faa8064b SHELL-AC7 — srt static policy credential `denyRead` provisioning
 * (shell-policy spec S4, compensating control C4). Pure filesystem unit tests:
 * no subprocess, temp settings file only.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SRT_ALLOWED_DOMAINS,
  DEFAULT_SRT_DENY_READ,
  defaultSrtAllowWrite,
  provisionSrtPolicy,
} from '../srt-policy.js';

interface IPolicy {
  filesystem?: { allowWrite?: string[]; denyRead?: string[] };
  network?: { allowedDomains?: string[] };
}

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'srt-denyread-'));
  settingsPath = join(dir, 'srt-settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<IPolicy> =>
  JSON.parse(await readFile(settingsPath, 'utf8')) as IPolicy;

describe('srt-policy default denyRead', () => {
  it('faa8064b SHELL-AC7a: generated policy denyRead contains every home-expanded default when the user policy has none', async () => {
    const home = homedir();
    const expected = [
      join(home, '.npmrc'),
      join(home, '.ssh'),
      join(home, '.aws'),
      join(home, '.config', 'gh'),
      join(home, '.netrc'),
    ];
    expect([...DEFAULT_SRT_DENY_READ]).toEqual(expected);

    const result = provisionSrtPolicy({ settingsPath });
    for (const p of expected) {
      expect(result.settings.filesystem?.denyRead).toContain(p);
      expect(p.startsWith('~')).toBe(false);
    }
    expect((await read()).filesystem?.denyRead).toEqual(expected);
  });

  it('faa8064b SHELL-AC7b: pre-existing user denyRead entries are preserved and de-duplicated', async () => {
    const home = homedir();
    await writeFile(
      settingsPath,
      JSON.stringify({
        filesystem: { denyRead: ['/secret', join(home, '.ssh')] },
      }),
      'utf8'
    );

    provisionSrtPolicy({ settingsPath });
    const deny = (await read()).filesystem?.denyRead ?? [];

    expect(deny).toContain('/secret');
    for (const p of DEFAULT_SRT_DENY_READ) expect(deny).toContain(p);
    expect(deny.filter((p) => p === join(home, '.ssh'))).toHaveLength(1);
    expect(new Set(deny).size).toBe(deny.length);
    // user entries keep their position ahead of the added defaults
    expect(deny[0]).toBe('/secret');

    // idempotent: a second provision changes nothing
    const again = provisionSrtPolicy({ settingsPath });
    expect(again.updated).toBe(false);
  });

  it('faa8064b SHELL-AC7c: allowWrite and allowedDomains output is unchanged for a fixture (golden compare)', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        filesystem: { allowWrite: ['/user/proj'] },
        network: { allowedDomains: ['example.org'] },
      }),
      'utf8'
    );

    provisionSrtPolicy({
      settingsPath,
      allowWrite: ['/extra/root'],
      allowedDomains: ['registry.example.com'],
    });
    const out = await read();

    const home = homedir();
    const goldenAllowWrite = [
      '/user/proj',
      join(home, '.cache', 'uv'),
      join(home, '.local', 'share', 'uv'),
      join(home, '.local', 'share'),
      join(home, '.npm'),
      join(home, '.cache'),
      join(home, 'Library', 'Caches'),
      tmpdir(),
      '/extra/root',
    ];
    expect(out.filesystem?.allowWrite).toEqual([...new Set(goldenAllowWrite)]);
    expect(defaultSrtAllowWrite()).toEqual(
      expect.arrayContaining(goldenAllowWrite.slice(1, -1))
    );
    expect(out.network?.allowedDomains).toEqual([
      'example.org',
      ...DEFAULT_SRT_ALLOWED_DOMAINS,
      'registry.example.com',
    ]);
    expect([...DEFAULT_SRT_ALLOWED_DOMAINS]).toEqual([
      'pypi.org',
      '*.pypi.org',
      'files.pythonhosted.org',
    ]);
  });
});
