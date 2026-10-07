/**
 * report-hygiene.e2e.ts — 4a979cef B-AC13: `report/deploy-verify.sh` run as a
 * process. With neither `RESTORE_MIN_SHA` nor `FROZEN_DIST` in the environment
 * and a manifest that lacks them, it exits 2 with a usage message naming both
 * (never a baked-in default); `--help` still works without them.
 *
 * Resource lane: spawns bash.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv } from './test/helpers/git-env.js';
import { spawnTimeoutMs } from './test/helpers/spawn-timeout.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'report', 'deploy-verify.sh');

describe('4a979cef B-AC13 — deploy-verify.sh required inputs', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'deploy-verify-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string>) =>
    spawnSync('bash', [SCRIPT, ...args], {
      env: gitEnv({ PATH: process.env['PATH'] ?? '', ...env }),
      encoding: 'utf8',
      timeout: spawnTimeoutMs(),
    });

  it('4a979cef B-AC13 exits 2 naming both inputs when neither env nor manifest provides them', () => {
    const manifest = join(tmp, 'm.json');
    writeFileSync(manifest, JSON.stringify({ sourceSha: 'a'.repeat(40), distSha256: 'b'.repeat(64) }));
    const r = run([], { RELEASE_MANIFEST: manifest });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain('RESTORE_MIN_SHA');
    expect(r.stderr).toContain('FROZEN_DIST');
    expect(r.stderr).toContain('usage:');
  });

  it('4a979cef B-AC13 --help works without the inputs', () => {
    const r = run(['--help'], { RELEASE_MANIFEST: join(tmp, 'absent.json') });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('deploy-verify.sh');
  });
});
