/**
 * BK7 (backlog 515a2b50, plan 9ed453c1) — F2: the DEFAULT srt policy must let a legitimate
 * `adhd-backlog` call take its store lease under ~/.adhd/backlog, and must NOT widen writes anywhere
 * else. Drives the REAL `srt` binary and the REAL built `adhd-backlog` bin (entrypoint/backlog/dist)
 * against a scratch fake HOME, so no production backlog is touched. No env gate: a missing `srt` or a
 * missing backlog build FAILS loudly (AGENTS.md live-testing rule); the e2e target builds the bin.
 *
 *   AC7.1  default policy: a real `adhd-backlog` query takes the lease + SQLite -wal/-shm, exit 0.
 *   AC7.2  writes outside the allow list (HOME, ~/.adhd/agent-mcp, ~/.adhd/other, ~/.ssh) EPERM.
 *   AC7.4  negative control: the SAME run with the allow entry removed is denied (teeth).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionSrtPolicy, resolveNativeBinDir } from '../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BACKLOG_BIN = join(REPO_ROOT, 'entrypoint', 'backlog', 'dist', 'index.js');

let workdir = '';
let home = '';
let srt = '';

/** Provision a policy for the fake HOME (homedir() reads $HOME), optionally overriding the extra roots. */
function policyFor(name: string, extraAllowWrite?: string[]): string {
  const path = join(workdir, `${name}.srt.json`);
  const prev = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    provisionSrtPolicy({ settingsPath: path, ...(extraAllowWrite ? { extraAllowWrite } : {}) });
  } finally {
    if (prev === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prev;
  }
  return path;
}

function runInSandbox(policy: string, argv: string[]) {
  return spawnSync(srt, ['-s', policy, ...argv], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

const BACKLOG_QUERY = [process.execPath, BACKLOG_BIN, 'backlog', 'query', '--input', '{"limit":1}'];

beforeAll(async () => {
  const bin = resolveNativeBinDir();
  srt = bin ? join(bin, 'srt') : '';
  expect(existsSync(srt), 'srt must be installed (node_modules/.bin/srt) — BK7 requires the real sandbox').toBe(true);
  expect(existsSync(BACKLOG_BIN), `built adhd-backlog bin missing: ${BACKLOG_BIN} (build the backlog project first)`).toBe(true);
  const root = join(REPO_ROOT, 'tmp', 'agent-mcp');
  await mkdir(root, { recursive: true });
  workdir = await mkdtemp(join(root, 'srt-bk7-'));
  home = join(workdir, 'home');
  // Pre-create the sibling dirs so a denial is EPERM (policy), never ENOENT (missing dir).
  for (const d of ['.adhd', '.adhd/agent-mcp', '.adhd/other', '.ssh']) await mkdir(join(home, d), { recursive: true });
});

afterAll(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]
  );
}

describe('515a2b50 BK7 — default srt policy vs ~/.adhd/backlog', () => {
  it('AC7.4 NEGATIVE CONTROL: with the backlog allow entry removed, the real adhd-backlog call is denied', () => {
    const r = runInSandbox(policyFor('no-backlog', []), BACKLOG_QUERY);
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).not.toBe(0);
    // The failure is the F2 symptom itself (EPERM creating the store dir), not an unrelated crash.
    expect(`${r.stdout}${r.stderr}`).toMatch(/EPERM: operation not permitted, mkdir '[^']*\.adhd\/backlog/);
    expect(listFiles(join(home, '.adhd', 'backlog'))).toEqual([]);
  });

  it('AC7.1 default policy: a real adhd-backlog call takes the store lease (+ SQLite sidecars) and exits 0', () => {
    const r = runInSandbox(policyFor('default'), BACKLOG_QUERY);
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')).toMatchObject({ ok: true });
    const files = listFiles(join(home, '.adhd', 'backlog')).map((f) => f.split('/').pop() ?? f);
    expect(files).toContain('backlog.db');
    // The sidecars sit in the allowed DIRECTORY, so they are covered without per-file rules.
    expect(files.some((f) => /\.db-(wal|shm)/.test(f))).toBe(true);
  });

  it.each([
    ['$HOME/x', 'x'],
    ['~/.adhd/agent-mcp/x', '.adhd/agent-mcp/x'],
    ['~/.adhd/other/x', '.adhd/other/x'],
    ['~/.ssh/x', '.ssh/x'],
  ])('AC7.2 default policy still denies a write to %s', (_label, rel) => {
    const target = join(home, rel);
    const r = runInSandbox(policyFor('default'), ['/bin/sh', '-c', `printf deny > "${target}"`]);
    expect(r.status, `a write to ${target} must be denied`).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('AC7.2 control: the allowed dir IS writable (so the denials above are policy, not a broken harness)', () => {
    const target = join(home, '.adhd', 'backlog', 'probe.txt');
    const r = runInSandbox(policyFor('default'), ['/bin/sh', '-c', `mkdir -p "${join(home, '.adhd', 'backlog')}" && printf ok > "${target}"`]);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(statSync(target).size).toBe(2);
  });

  it('AC7.3 the policy file the sandbox ran under is mode 0600', () => {
    expect(statSync(policyFor('default')).mode & 0o777).toBe(0o600);
  });
});
