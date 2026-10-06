/**
 * NAT-TOOL-4 — the `srt`-wrapped builtins ACTUALLY SPAWN under the provisioned
 * policy (ADR-0008 D7; deferral a5a2f1d4).
 *
 * `resolveNativeTooling` wraps the `fs`/`shell` builtins with
 * `@anthropic-ai/sandbox-runtime` (`srt`), which reads `~/.srt-settings.json`
 * and default-DENIES writes when no policy exists. This test drives the real
 * `srt` binary (a LOCAL dependency — no external service, so it runs by
 * default) under a policy written by the host's `provisionSrtPolicy`, and
 * proves the policy is what makes the sandboxed child run.
 *
 * Teeth: the negative control spawns the SAME command with NO policy and MUST
 * be denied (exit != 0, no file). If `provisionSrtPolicy` stopped writing the
 * policy, the positive half goes red; if srt stopped confining, the negative
 * half goes red.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ensureBinDirOnPath,
  provisionSrtPolicy,
  resolveNativeBinDir,
} from '../../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** The sandboxed command: write a proof file into the policy-allowed HOME. */
const PROOF_SCRIPT = 'printf srt-spawn-proof > "$HOME/proof.txt"';

function runSrt(home: string): { status: number | null; error?: Error } {
  const binDir = resolveNativeBinDir();
  const srt = binDir ? join(binDir, 'srt') : 'srt';
  const result = spawnSync(srt, ['/bin/sh', '-c', PROOF_SCRIPT], {
    env: { ...process.env, HOME: home, PATH: ensureBinDirOnPath(process.env['PATH']) },
    encoding: 'utf8',
  });
  return { status: result.status, error: result.error };
}

describe('srt-wrapped builtins spawn under the provisioned policy', () => {
  let workdir = '';
  let home = '';
  let noPolicyHome = '';
  let mergeHome = '';

  beforeAll(async () => {
    const scratchRoot = join(REPO_ROOT, 'tmp', 'agent-mcp');
    await mkdir(scratchRoot, { recursive: true });
    workdir = await mkdtemp(join(scratchRoot, 'srt-spawn-'));
    home = join(workdir, 'home');
    noPolicyHome = join(workdir, 'home-no-policy');
    mergeHome = join(workdir, 'home-merge');
    await mkdir(home, { recursive: true });
    await mkdir(noPolicyHome, { recursive: true });
    await mkdir(mergeHome, { recursive: true });
  });

  afterAll(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it('runs a sandboxed child when provisionSrtPolicy wrote an allowing policy', async () => {
    provisionSrtPolicy({ settingsPath: join(home, '.srt-settings.json'), allowWrite: [home] });
    expect(existsSync(join(home, '.srt-settings.json'))).toBe(true);

    const { status, error } = runSrt(home);
    expect(error).toBeUndefined();
    expect(status).toBe(0);
    expect(await readFile(join(home, 'proof.txt'), 'utf8')).toBe('srt-spawn-proof');
  });

  it('NEGATIVE CONTROL: with no policy the SAME child is denied (proves the policy is load-bearing)', async () => {
    // `noPolicyHome` is never given a `.srt-settings.json` → srt's built-in
    // default-deny refuses the write.
    const { status } = runSrt(noPolicyHome);
    expect(status).not.toBe(0);
    expect(existsSync(join(noPolicyHome, 'proof.txt'))).toBe(false);
  });

  it('additively merges: a pre-existing denying policy keeps its denyWrite rule', async () => {
    const settingsPath = join(mergeHome, '.srt-settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({ filesystem: { denyWrite: [join(mergeHome, 'blocked')] }, network: {} }),
      'utf8'
    );
    const result = provisionSrtPolicy({ settingsPath, allowWrite: [mergeHome] });
    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      filesystem: { denyWrite: string[]; allowWrite: string[] };
    };
    expect(written.filesystem.denyWrite).toContain(join(mergeHome, 'blocked'));
    expect(written.filesystem.allowWrite).toContain(mergeHome);
    expect(result.created).toBe(false);
  });
});
