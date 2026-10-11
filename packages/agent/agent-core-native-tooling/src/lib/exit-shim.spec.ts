/**
 * 61358b6f — unit coverage of the exit-status shim (no subprocess; the real-server
 * proof is `shell-exit-status.e2e.test.ts`).
 */
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@adhd/agent-base-types';
import {
  EXIT_SHIM_ORIG_PATH_ENV,
  EXIT_SHIM_PROTECTED,
  LAUNCHER_SOURCE,
  SHELL_EXIT_SENTINEL_RE,
  formatExitSentinel,
  isExitShimProtected,
  prepareExitShimDir,
} from './exit-shim.js';
import { resolveNativeTooling } from './resolver.js';
import { SHELL_SERVER } from './catalog.js';

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
const made: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'exit-shim-spec-'));
  made.push(d);
  return d;
}
function fakeBin(dir: string, names: string[]): void {
  for (const n of names) writeFileSync(join(dir, n), '#!/bin/sh\n', { mode: 0o755 });
}
afterEach(() => {
  for (const d of made.splice(0)) {
    for (const e of existsSync(d) ? readdirSync(d) : []) {
      try {
        chmodSync(join(d, e), 0o755);
      } catch {
        /* not a dir */
      }
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('61358b6f AC6 shim directory contents', () => {
  it('shims PATH executables but never the protected runtime names', () => {
    const bin = scratch();
    fakeBin(bin, ['ls', 'false', 'uv', 'uvx', 'python3', 'python3.12', 'srt', 'node', 'sh', 'env', 'bash', 'zsh', 'bwrap', 'sandbox-exec', 'socat', 'which']);
    const { dir } = prepareExitShimDir({ origPath: bin, rootDir: scratch() });
    const names = readdirSync(dir).filter((n) => n !== '.launcher').sort();
    expect(names).toEqual(['false', 'ls']);
  });

  it('every name in the documented protected set is protected, prefix rule included', () => {
    for (const n of ['uv', 'uvx', 'srt', 'node', 'sh', 'env', 'bash', 'zsh', 'python', 'python3', 'python3.13']) {
      expect(isExitShimProtected(n), n).toBe(true);
    }
    expect(isExitShimProtected('ls')).toBe(false);
    expect(EXIT_SHIM_PROTECTED).toContain('python*');
  });

  it('first PATH entry wins for a duplicate name; non-executables and unsafe names are skipped', () => {
    const a = scratch();
    const b = scratch();
    fakeBin(a, ['tool']);
    fakeBin(b, ['tool', 'other']);
    writeFileSync(join(b, 'data.txt'), 'x', { mode: 0o644 });
    writeFileSync(join(b, 'we ird'), '#!/bin/sh\n', { mode: 0o755 });
    const { dir } = prepareExitShimDir({ origPath: [a, b].join(delimiter), rootDir: scratch() });
    expect(readdirSync(dir).filter((n) => n !== '.launcher').sort()).toEqual(['other', 'tool']);
  });

  it('every entry is a relative symlink to one launcher; the directory is sealed 0555', () => {
    const bin = scratch();
    fakeBin(bin, ['ls']);
    const { dir } = prepareExitShimDir({ origPath: bin, rootDir: scratch() });
    expect(lstatSync(join(dir, 'ls')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, 'ls'))).toBe('.launcher');
    expect(readFileSync(join(dir, '.launcher'), 'utf8')).toBe(LAUNCHER_SOURCE);
    expect(statSync(join(dir, '.launcher')).mode & 0o777).toBe(0o555);
    expect(statSync(dir).mode & 0o222).toBe(0);
  });

  it('is idempotent and keyed by the original PATH', () => {
    const bin = scratch();
    const other = scratch();
    fakeBin(bin, ['ls']);
    fakeBin(other, ['ls']);
    const root = scratch();
    const one = prepareExitShimDir({ origPath: bin, rootDir: root });
    const two = prepareExitShimDir({ origPath: bin, rootDir: root });
    const three = prepareExitShimDir({ origPath: other, rootDir: root });
    expect(two.dir).toBe(one.dir);
    expect(three.dir).not.toBe(one.dir);
    expect(one.origPath).toBe(bin);
    // No staging residue survives.
    expect(readdirSync(root).filter((n) => n.startsWith('.staging'))).toEqual([]);
  });
});

describe('61358b6f launcher contract', () => {
  it('is POSIX sh with a /bin/sh shebang, reads the original PATH, and prints the sentinel only on non-zero', () => {
    expect(LAUNCHER_SOURCE.startsWith('#!/bin/sh\n')).toBe(true);
    expect(LAUNCHER_SOURCE).toContain(EXIT_SHIM_ORIG_PATH_ENV);
    expect(LAUNCHER_SOURCE).toContain('[ "$rc" -ne 0 ]');
    expect(LAUNCHER_SOURCE).toContain("printf '[exit status: %s]\\n' \"$rc\" >&2");
    expect(LAUNCHER_SOURCE).toContain('<&0 &'); // stdin explicitly inherited by the backgrounded child
    for (const sig of ['TERM', 'INT', 'HUP']) expect(LAUNCHER_SOURCE).toContain(`-${sig}`);
  });

  it('formatExitSentinel output is accepted by the sentinel regex', () => {
    expect(SHELL_EXIT_SENTINEL_RE.exec(formatExitSentinel(7))?.[1]).toBe('7');
  });
});

describe('61358b6f AC10 resolver wiring', () => {
  const ctxBase = { cwd: '/work' };
  const shell = (env: Record<string, string> | undefined, sandbox: boolean, exitShim?: { dir: string; origPath: string }, userEnv?: Record<string, string>) => {
    const [s] = resolveNativeTooling(
      { fs: false, dispatch: false, shell: { allowCommands: ['ls'], ...(userEnv ? { env: userEnv } : {}) } },
      { ...ctxBase, sandbox, ...(env ? { env } : {}), ...(exitShim ? { exitShim } : {}) }
    ) as Stdio[];
    return s;
  };
  const KEY = SHELL_SERVER.envKeys.childEnvAllowlist;

  for (const sandbox of [true, false]) {
    it(`sandbox=${sandbox}: PATH leads with the shim dir, the original PATH rides in ADHD_SHIM_ORIG_PATH and the child-env allowlist`, () => {
      const s = shell(undefined, sandbox, { dir: '/shim/abc', origPath: '/usr/bin:/bin' });
      expect(s.env?.PATH).toBe(`/shim/abc${delimiter}/usr/bin:/bin`);
      expect(s.env?.ADHD_SHIM_ORIG_PATH).toBe('/usr/bin:/bin');
      expect((s.env?.[KEY] ?? '').split(',')).toContain('ADHD_SHIM_ORIG_PATH');
    });

    it(`sandbox=${sandbox}: a user-supplied child-env allowlist is merged, never overwritten`, () => {
      const s = shell({ [KEY]: 'FOO,BAR' }, sandbox, { dir: '/shim/abc', origPath: '/usr/bin' });
      const names = (s.env?.[KEY] ?? '').split(',');
      expect(names.slice(0, 2)).toEqual(['FOO', 'BAR']);
      expect(names).toContain('ADHD_SHIM_ORIG_PATH');
      const viaShellEnv = shell(undefined, sandbox, { dir: '/shim/abc', origPath: '/usr/bin' }, { [KEY]: 'USER_ONE' });
      expect((viaShellEnv.env?.[KEY] ?? '').split(',')).toEqual(expect.arrayContaining(['USER_ONE', 'ADHD_SHIM_ORIG_PATH']));
    });

    it(`sandbox=${sandbox}: without exitShim the resolved env is exactly today's (no PATH, no shim names)`, () => {
      const s = shell(undefined, sandbox);
      expect(s.env?.PATH).toBeUndefined();
      expect(s.env?.ADHD_SHIM_ORIG_PATH).toBeUndefined();
      expect(s.env?.[KEY] ?? '').not.toContain('ADHD_SHIM_ORIG_PATH');
    });
  }

  it('AC4: the shim never changes the allowlist env the server enforces', () => {
    const withShim = shell(undefined, true, { dir: '/shim/abc', origPath: '/usr/bin' });
    const without = shell(undefined, true);
    for (const k of ['ALLOW_COMMANDS', 'ALLOW_PATTERNS']) expect(withShim.env?.[k]).toBe(without.env?.[k]);
    expect(withShim.command).toBe(without.command);
    expect(withShim.args).toEqual(without.args);
  });

  it('a custom shell McpServerConfig is never touched by exitShim', () => {
    const custom: McpServerConfig = { transport: 'stdio', command: 'my-shell', args: [] };
    const [s] = resolveNativeTooling(
      { fs: false, dispatch: false, shell: custom },
      { cwd: '/work', exitShim: { dir: '/shim/abc', origPath: '/usr/bin' } }
    );
    expect(s).toEqual(custom);
  });
});
