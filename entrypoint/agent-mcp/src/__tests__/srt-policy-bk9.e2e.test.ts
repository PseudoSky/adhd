/**
 * BK9 AC9.4 (backlog 3ad735bb, plan 9ed453c1) — under the REAL `srt` sandbox: a spill file written by the
 * host is READABLE by the sandboxed shell (it is how the model follows the stub), ONLY when spill is
 * enabled, and writes stay denied everywhere (the spill dir is read-allowed, never write-allowed).
 *
 * srt reads by default-allow minus `denyRead`, and `allowRead` re-opens paths inside a denied region. So the
 * teeth here come from a hardened-host policy that denies the whole agent-mcp temp tree (it holds
 * credential-bearing scratch) and relies on the spill allowRead to open exactly one subdirectory.
 * No env gate: a missing `srt` FAILS loudly (AGENTS.md live-testing rule).
 *
 *   control     spill OFF  -> the sandboxed `cat <spill file>` is denied
 *   AC9.4       spill ON   -> `cat` / `sed -n 1000p` succeed and return the exact text
 *   AC9.4       spill ON   -> a sibling credential scratch file in the same temp tree is still unreadable
 *   AC9.4       spill ON   -> writes outside the allow list (HOME, the spill dir, the spill file) stay denied
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capOrSpillToolResult } from '@adhd/agent-engine-orchestrator';

import { provisionSrtPolicy, resolveNativeBinDir } from '../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let workdir = '';
let home = '';
let temp = '';
let spillDir = '';
let srt = '';
let spillFile = '';
let secretFile = '';
let body = '';

/** Provision a per-run style policy for the fake HOME; `spill` toggles the BK9 read allow. */
function policyFor(name: string, spill: boolean): string {
  const path = join(workdir, `${name}.srt.json`);
  // A hardened host denies the whole agent-mcp temp tree (credential-bearing scratch).
  writeFileSync(path, JSON.stringify({ filesystem: { denyRead: [temp] } }));
  const prev = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    provisionSrtPolicy({
      settingsPath: path,
      applySandboxExtras: true,
      spillReadDir: spill ? spillDir : null,
    });
  } finally {
    if (prev === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prev;
  }
  return path;
}

function runInSandbox(policy: string, argv: string[]) {
  return spawnSync(srt, ['-s', policy, ...argv], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120_000 });
}

beforeAll(async () => {
  const bin = resolveNativeBinDir();
  srt = bin ? join(bin, 'srt') : '';
  expect(existsSync(srt), 'srt must be installed (node_modules/.bin/srt) — BK9 AC9.4 requires the real sandbox').toBe(true);
  const root = join(REPO_ROOT, 'tmp', 'agent-mcp');
  await mkdir(root, { recursive: true });
  workdir = realpathSync(await mkdtemp(join(root, 'srt-bk9-')));
  home = join(workdir, 'home');
  temp = join(home, '.adhd', 'agent-mcp', 'production', 'temp');
  spillDir = join(temp, 'tool-results');
  mkdirSync(join(temp, 'srt'), { recursive: true });
  // credential-bearing scratch that lives directly in the temp root (claudecli mcp-config / agent-spec)
  secretFile = join(temp, 'mcp-config-secret.json');
  writeFileSync(secretFile, '{"token":"SECRET"}');
  // The HOST (orchestrator) writes the spill file, outside the sandbox.
  body = Array.from({ length: 5000 }, (_, i) => `L${String(i + 1).padStart(6, '0')}: filler filler filler`).join('\n');
  const out = capOrSpillToolResult({
    result: [{ type: 'text', text: body }],
    isError: false,
    maxChars: 20_000,
    spill: { enabled: true, dir: spillDir, ttlMs: 3_600_000 },
    taskId: 'task-1',
    callId: 'call-1',
  });
  expect(out.spilled).toBe(true);
  spillFile = out.spillPath as string;
});

afterAll(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe('9ed453c1 BK9 AC9.4 spill dir under the real srt sandbox', () => {
  it('CONTROL (teeth): with spill OFF the temp tree is denied, so the sandboxed read of the spill file fails', () => {
    const r = runInSandbox(policyFor('off', false), ['/bin/cat', spillFile]);
    expect(r.status, `stdout=${r.stdout.slice(0, 80)}`).not.toBe(0);
    expect(r.stdout).not.toContain('L000001');
  });

  it('spill ON: the sandboxed shell reads the exact full text (cat) and a range (sed), as the stub instructs', () => {
    const policy = policyFor('on', true);
    const cat = runInSandbox(policy, ['/bin/cat', spillFile]);
    expect(cat.status, `stderr=${cat.stderr}`).toBe(0);
    expect(cat.stdout).toBe(body);
    const sed = runInSandbox(policy, ['/usr/bin/sed', '-n', '1000,1000p', spillFile]);
    expect(sed.status, `stderr=${sed.stderr}`).toBe(0);
    expect(sed.stdout.trim()).toBe('L001000: filler filler filler');
  });

  it('spill ON opens ONLY the spill dir: a sibling credential scratch file in the same temp tree stays unreadable', () => {
    const r = runInSandbox(policyFor('on-sibling', true), ['/bin/cat', secretFile]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('SECRET');
  });

  it.each([
    ['a new file in $HOME', () => join(home, 'planted.txt')],
    ['a new file in the spill dir (read-only allow)', () => join(spillDir, 'planted.txt')],
    ['a new file in the task spill dir', () => join(spillDir, 'task-1', 'planted.txt')],
    ['the temp tree', () => join(temp, 'planted.txt')],
  ])('spill ON still denies writing %s', (_label, target) => {
    const t = target();
    const r = runInSandbox(policyFor('on-write', true), ['/bin/sh', '-c', `printf evil > "${t}"`]);
    expect(r.status, `a write to ${t} must be denied`).not.toBe(0);
    expect(existsSync(t)).toBe(false);
  });

  it('spill ON cannot overwrite or truncate the spill file itself', () => {
    const r = runInSandbox(policyFor('on-overwrite', true), ['/bin/sh', '-c', `printf evil > "${spillFile}"`]);
    expect(r.status).not.toBe(0);
    expect(readFileSync(spillFile, 'utf8')).toBe(body);
  });
});
