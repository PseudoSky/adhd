/**
 * BK7 (backlog 515a2b50, plan 9ed453c1) — F2 + the security-review corrections: the DEFAULT srt policy
 * must let a legitimate `adhd-backlog` call take its store lease under the production DATA dir, and
 * must NOT widen writes anywhere else. Drives the REAL `srt` binary and the REAL built `adhd-backlog`
 * bin against a scratch fake HOME with the production store layout, so no real backlog is touched.
 * No env gate: a missing `srt` or a missing backlog build FAILS loudly (AGENTS.md live-testing rule);
 * the e2e target builds the bin.
 *
 *   AC7.1  default policy: a real `adhd-backlog` query takes the lease + SQLite -wal/-shm, exit 0.
 *   AC7.2  writes outside the allow list (HOME, ~/.adhd/agent-mcp, ~/.adhd/other, ~/.ssh) EPERM.
 *   AC7.4  negative control: the SAME run with the allow entry removed is denied (teeth).
 *   SEC-F1 the allow is the production data dir only; config.yaml / backups / cache / the backlog
 *          root stay unwritable; a denyWrite INSIDE an allowed dir wins under real srt.
 *   SEC-F2 a sandbox that plants sidecar symlinks inside the data dir cannot make the next UNSANDBOXED
 *          backlog run truncate/modify a file outside it; it cannot plant anything outside the data dir.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionSrtPolicy, resolveNativeBinDir } from '../srt-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BACKLOG_BIN = join(REPO_ROOT, 'entrypoint', 'backlog', 'dist', 'index.js');
const CONFIG_YAML = 'embedding:\n  enabled: false\n';

let workdir = '';
let home = '';
let srt = '';
/** The production store layout inside the fake HOME. */
let production = '';
let dataDir = '';

/** Provision a policy for the fake HOME (homedir() reads $HOME), optionally overriding the extra roots. */
function policyFor(name: string, extraAllowWrite?: string[], allowWrite?: string[]): string {
  const path = join(workdir, `${name}.srt.json`);
  const prev = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    provisionSrtPolicy({
      settingsPath: path,
      applySandboxExtras: true,
      ...(extraAllowWrite ? { extraAllowWrite } : {}),
      ...(allowWrite ? { allowWrite } : {}),
    });
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

/** The same backlog call, UNSANDBOXED, as the host/user runs it. */
function runOnHost(argv: string[]) {
  return spawnSync(argv[0] as string, argv.slice(1), { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120_000 });
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const BACKLOG_QUERY = [process.execPath, BACKLOG_BIN, 'backlog', 'query', '--input', '{"limit":1}'];

beforeAll(async () => {
  const bin = resolveNativeBinDir();
  srt = bin ? join(bin, 'srt') : '';
  expect(existsSync(srt), 'srt must be installed (node_modules/.bin/srt) — BK7 requires the real sandbox').toBe(true);
  expect(existsSync(BACKLOG_BIN), `built adhd-backlog bin missing: ${BACKLOG_BIN} (build the backlog project first)`).toBe(true);
  const root = join(REPO_ROOT, 'tmp', 'agent-mcp');
  await mkdir(root, { recursive: true });
  workdir = realpathSync(await mkdtemp(join(root, 'srt-bk7-')));
  home = join(workdir, 'home');
  production = join(home, '.adhd', 'backlog', 'production');
  dataDir = join(production, 'data');
  // Pre-create the sibling dirs so a denial is EPERM (policy), never ENOENT (missing dir).
  for (const d of ['.adhd/agent-mcp', '.adhd/other', '.ssh', '.adhd/backlog/production/backups', '.adhd/backlog/production/cache']) {
    await mkdir(join(home, d), { recursive: true });
  }
  // The production config the host's NEXT unsandboxed run would read (embedding off keeps the proof fast).
  writeFileSync(join(production, 'config.yaml'), CONFIG_YAML);
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

describe('515a2b50 BK7 — default srt policy vs the production backlog data dir', () => {
  it('AC7.4 NEGATIVE CONTROL: with the backlog allow entry removed, the real adhd-backlog call is denied', () => {
    const r = runInSandbox(policyFor('no-backlog', []), BACKLOG_QUERY);
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).not.toBe(0);
    // The failure is the F2 symptom itself (EPERM creating the store dir), not an unrelated crash.
    expect(`${r.stdout}${r.stderr}`).toMatch(/EPERM: operation not permitted, mkdir '[^']*\.adhd\/backlog/);
    expect(listFiles(dataDir)).toEqual([]);
  });

  it('AC7.1 / SEC-F1 default policy: a real adhd-backlog call takes the store lease (+ SQLite sidecars) in production/data only and exits 0', () => {
    const r = runInSandbox(policyFor('default'), BACKLOG_QUERY);
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').find((l) => l.startsWith('{"ok"')) ?? '{}')).toMatchObject({ ok: true });
    const files = listFiles(dataDir).map((f) => f.split('/').pop() ?? f);
    expect(files).toContain('backlog.db');
    // The sidecars sit in the allowed DIRECTORY, so they are covered without per-file rules.
    expect(files.some((f) => /\.db-(wal|shm)/.test(f))).toBe(true);
    // Nothing else under the backlog root was written: config.yaml untouched, backups/cache empty.
    expect(readFileSync(join(production, 'config.yaml'), 'utf8')).toBe(CONFIG_YAML);
    expect(listFiles(join(production, 'backups'))).toEqual([]);
    expect(listFiles(join(production, 'cache'))).toEqual([]);
  });

  it.each([
    ['$HOME/x', 'x'],
    ['~/.adhd/agent-mcp/x', '.adhd/agent-mcp/x'],
    ['~/.adhd/other/x', '.adhd/other/x'],
    ['~/.ssh/x', '.ssh/x'],
    ['SEC-F1 ~/.adhd/backlog/x (the root)', '.adhd/backlog/x'],
    ['SEC-F1 production/x', '.adhd/backlog/production/x'],
    ['SEC-F1 production/backups/x', '.adhd/backlog/production/backups/x'],
    ['SEC-F1 production/cache/x', '.adhd/backlog/production/cache/x'],
    ['SEC-F1 production/config.yaml (overwrite)', '.adhd/backlog/production/config.yaml'],
  ])('AC7.2 default policy still denies a write to %s', (_label, rel) => {
    const target = join(home, rel);
    const before = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    const r = runInSandbox(policyFor('default'), ['/bin/sh', '-c', `printf deny > "${target}"`]);
    expect(r.status, `a write to ${target} must be denied`).not.toBe(0);
    expect(existsSync(target) ? readFileSync(target, 'utf8') : undefined).toBe(before);
  });

  it('AC7.2 control: the allowed data dir IS writable (so the denials above are policy, not a broken harness)', () => {
    const target = join(dataDir, 'probe.txt');
    const r = runInSandbox(policyFor('default'), ['/bin/sh', '-c', `mkdir -p "${dataDir}" && printf ok > "${target}"`]);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(statSync(target).size).toBe(2);
  });

  it('SEC-F1 denyWrite INSIDE an allowed dir wins under real srt (config.yaml / backups denied even when production/ is allowed)', () => {
    // A wider operator allow (production/, passed as a raw allowWrite) must still not reach the managed denyWrite set.
    const policy = policyFor('wide', undefined, [production]);
    const cfg = join(production, 'config.yaml');
    const denied = runInSandbox(policy, ['/bin/sh', '-c', `printf evil > "${cfg}"`]);
    expect(denied.status).not.toBe(0);
    expect(readFileSync(cfg, 'utf8')).toBe(CONFIG_YAML);
    const deniedBackup = runInSandbox(policy, ['/bin/sh', '-c', `printf evil > "${join(production, 'backups', 'b')}"`]);
    expect(deniedBackup.status).not.toBe(0);
    // Control: the same wider allow DOES permit an unprotected sibling (cache), so the denies above are the deny rule winning.
    const ok = runInSandbox(policy, ['/bin/sh', '-c', `printf ok > "${join(production, 'cache', 'c')}"`]);
    expect(ok.status, `stderr=${ok.stderr}`).toBe(0);
  });

  it('AC7.3 the policy file the sandbox ran under is mode 0600', () => {
    expect(statSync(policyFor('default')).mode & 0o777).toBe(0o600);
  });
});

describe('515a2b50 SEC-F2 — a sandbox that writes the data dir cannot turn the host into a write primitive', () => {
  it('cannot plant ANY entry outside production/data (sibling dirs, config.yaml, backups)', () => {
    const victim = join(workdir, 'outside-victim.txt');
    writeFileSync(victim, 'SECRET\n');
    const policy = policyFor('default');
    for (const link of [
      join(production, 'backlog-evil.db-wal'),
      join(production, 'cache', 'planted'),
      join(production, 'backups', 'planted'),
      join(home, '.adhd', 'backlog', 'planted'),
    ]) {
      const r = runInSandbox(policy, ['/bin/sh', '-c', `ln -s "${victim}" "${link}"`]);
      expect(r.status, `planting ${link} must be denied`).not.toBe(0);
      expect(exists(link), `${link} must not exist`).toBe(false);
    }
  });

  it('a -wal / lease-dir symlink planted INSIDE the data dir cannot make the next UNSANDBOXED backlog run touch the victim', () => {
    const victimFile = join(workdir, 'victim-file.txt');
    const victimDir = join(workdir, 'victim-dir');
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(victimFile, 'SECRET\n');
    const policy = policyFor('default');
    // 1. a legitimate sandboxed call builds the store; 2. the sandbox then plants the links (allowed: it owns this dir).
    expect(runInSandbox(policy, BACKLOG_QUERY).status).toBe(0);
    const plant = runInSandbox(policy, [
      '/bin/sh',
      '-c',
      `rm -rf "${dataDir}"/backlog.db-wal "${dataDir}"/backlog.db-shm "${dataDir}"/backlog.db.sox-lease.d && ` +
        `ln -s "${victimFile}" "${dataDir}/backlog.db-wal" && ln -s "${victimDir}" "${dataDir}/backlog.db.sox-lease.d"`,
    ]);
    expect(plant.status, `stderr=${plant.stderr}`).toBe(0);
    expect(lstatSync(join(dataDir, 'backlog.db-wal')).isSymbolicLink()).toBe(true);
    // 3. the host (full privileges) runs the real backlog bin: it must remove the planted links, never follow them.
    const host = runOnHost(BACKLOG_QUERY);
    expect(host.status, `stdout=${host.stdout}\nstderr=${host.stderr}`).toBe(0);
    expect(readFileSync(victimFile, 'utf8')).toBe('SECRET\n');
    expect(readdirSync(victimDir)).toEqual([]);
    expect(host.stderr).toContain('removed planted symlink sidecar');
  });
});
