import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from '@adhd/agent-base-types';
import { resolveNativeTooling, resolveNativeToolingMap } from './resolver.js';
import {
  DISPATCH_SERVER_KEY,
  FS_SERVER,
  SHELL_SERVER,
  SRT_SANDBOX,
} from './catalog.js';

const dispatchSelf: McpServerConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@adhd/agent-mcp@latest'],
};

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
const stdio = (servers: McpServerConfig[]): Stdio[] =>
  servers.filter((s): s is Stdio => s.transport === 'stdio');

/**
 * Unwrap the adopted `srt` sandbox so tests can assert the underlying server.
 * The resolver wraps the fs/shell builtins with `srt` by default (ADR-0008 D7),
 * so `command` is `srt` and `args[0]` is the real command.
 */
const unwrap = (s: Stdio): Stdio =>
  s.command === SRT_SANDBOX.command && s.args?.[0]
    ? { ...s, command: s.args[0], args: s.args.slice(1) }
    : s;

const fsServer = (servers: McpServerConfig[]): Stdio | undefined =>
  stdio(servers)
    .map(unwrap)
    .find((s) => s.args?.includes('@modelcontextprotocol/server-filesystem'));

const shellServer = (servers: McpServerConfig[]): Stdio | undefined =>
  stdio(servers)
    .map(unwrap)
    .find((s) => s.command === 'uvx' && s.args?.includes('mcp-shell-server'));

describe('resolveNativeTooling — task-time resolution (ADR-0008 D2/D4)', () => {
  it('AC1: {fs:true,shell:true,dispatch:true} yields 3 servers rooted at the task cwd', () => {
    const servers = resolveNativeTooling(
      { fs: true, shell: true, dispatch: true },
      { cwd: '/p/a', dispatchSelf }
    );
    expect(servers).toHaveLength(3);
    const fs = fsServer(servers);
    expect(fs).toBeDefined();
    expect(fs!.args).toContain('/p/a'); // fs root injected as the final arg
    expect(fs!.cwd).toBe('/p/a');
    expect(shellServer(servers)!.cwd).toBe('/p/a'); // shell runs in the task cwd
  });

  it('AC2: the same config at /p/b differs ONLY in the root path', () => {
    const a = resolveNativeTooling({ fs: true, shell: true }, { cwd: '/p/a' });
    const b = resolveNativeTooling({ fs: true, shell: true }, { cwd: '/p/b' });
    expect(a).not.toEqual(b);
    // Replace the root in A; the results must then be byte-identical — proving the
    // cwd is the ONLY source of difference (no definition-time root leaked in).
    const aNormalized = JSON.parse(JSON.stringify(a).split('/p/a').join('/p/b'));
    expect(aNormalized).toEqual(b);
  });

  it('AC4: {fs:false} omits the fs server while other members remain', () => {
    const servers = resolveNativeTooling({ fs: false, shell: true }, { cwd: '/p/a' });
    expect(fsServer(servers)).toBeUndefined();
    expect(shellServer(servers)).toBeDefined();
  });

  it('{shell:false} omits the shell server while the fs server remains', () => {
    const servers = resolveNativeTooling({ fs: true, shell: false }, { cwd: '/p/a' });
    expect(shellServer(servers)).toBeUndefined();
    expect(fsServer(servers)).toBeDefined();
  });

  it('dispatch:true surfaces the REAL host-supplied agent-mcp server (never a wrapper)', () => {
    const servers = resolveNativeTooling(
      { fs: false, shell: false, dispatch: true },
      { cwd: '/p/a', dispatchSelf }
    );
    expect(servers).toEqual([dispatchSelf]);
  });

  it('dispatch is omitted when no dispatchSelf exists (a wrapper is never authored)', () => {
    const servers = resolveNativeTooling({ fs: false, shell: false, dispatch: true }, { cwd: '/p/a' });
    expect(servers).toEqual([]);
  });

  it('a custom McpServerConfig REPLACES the builtin (D3) and is never sandbox-wrapped', () => {
    const custom: McpServerConfig = { transport: 'stdio', command: 'my-fs', args: ['--root', '/x'] };
    const servers = resolveNativeTooling({ fs: custom, shell: false, dispatch: false }, { cwd: '/p/a' });
    expect(servers).toEqual([custom]);
  });

  it('shell allowCommands/timeoutMs become adopted-server env passthrough', () => {
    const servers = resolveNativeTooling(
      { fs: false, shell: { allowCommands: ['ls', 'git'], timeoutMs: 45_000 } },
      { cwd: '/p/a' }
    );
    const shell = shellServer(servers)!;
    expect(shell.env?.ALLOW_COMMANDS).toBe('ls,git');
    expect(shell.env?.MCP_SHELL_DEFAULT_TIMEOUT_SECONDS).toBe('45');
    // The adopted server is allow-list ONLY — a deny-list env does not exist, and
    // the harness must not emit a fictional one (ADR-0008 D5).
    expect(shell.env?.DENY_COMMANDS).toBeUndefined();
  });

  it('fs.root override pins the root arg while cwd stays the task cwd', () => {
    const servers = resolveNativeTooling(
      { fs: { root: '/fixed' }, shell: false, dispatch: false },
      { cwd: '/p/a' }
    );
    const fs = fsServer(servers)!;
    expect(fs.args![fs.args!.length - 1]).toBe('/fixed');
    expect(fs.cwd).toBe('/p/a');
  });

  it('base env is merged into every resolved stdio server', () => {
    const servers = resolveNativeTooling(
      { fs: true, shell: false, dispatch: false },
      { cwd: '/p/a', env: { FOO: 'bar' } }
    );
    expect(fsServer(servers)!.env).toEqual({ FOO: 'bar' });
  });

  it('NEVER mutates the stored config — the definition stays byte-identical across fires (D4)', () => {
    const cfg = { fs: { root: '/fixed' }, shell: true as const };
    const snapshot = JSON.stringify(cfg);
    resolveNativeTooling(cfg, { cwd: '/p/a' });
    resolveNativeTooling(cfg, { cwd: '/p/b' });
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });
});

describe('resolveNativeToolingMap — keyed projection, one producer (NAT-TOOL-4)', () => {
  const cfg = { fs: true, shell: true, dispatch: true } as const;
  const ctx = { cwd: '/p/a', dispatchSelf } as const;

  it('keys the builtins by their catalog serverKey (fs/shell/agent-mcp)', () => {
    const map = resolveNativeToolingMap(cfg, ctx);
    expect(Object.keys(map).sort()).toEqual(
      [DISPATCH_SERVER_KEY, FS_SERVER.key, SHELL_SERVER.key].sort()
    );
    expect(Object.keys(map).sort()).toEqual(['agent-mcp', 'fs', 'shell']);
  });

  it('is the SAME computation as the array form — values identical, in order', () => {
    const map = resolveNativeToolingMap(cfg, ctx);
    const arr = resolveNativeTooling(cfg, ctx);
    expect(Object.values(map)).toEqual(arr);
  });

  it('omits the key for a member disabled by config', () => {
    const map = resolveNativeToolingMap(
      { fs: false, shell: true, dispatch: false },
      { cwd: '/p/a' }
    );
    expect(Object.keys(map)).toEqual(['shell']);
  });

  it('NEVER mutates the stored config (no resolved root leaked back)', () => {
    const stored = { fs: true, shell: true, dispatch: true } as const;
    const snapshot = JSON.stringify(stored);
    resolveNativeToolingMap(stored, { cwd: '/p/a', dispatchSelf });
    expect(JSON.stringify(stored)).toBe(snapshot);
  });
});

describe('resolveNativeTooling — adopted srt sandbox wrapping (ADR-0008 D7)', () => {
  it('wraps BOTH the fs and shell builtins with `srt` by default', () => {
    const [fs, shell] = resolveNativeTooling(
      { fs: true, shell: true },
      { cwd: '/p/a' }
    ) as [Stdio, Stdio];
    expect(fs.command).toBe('srt');
    expect(fs.args?.slice(0, 2)).toEqual(['npx', '-y']);
    expect(shell.command).toBe('srt');
    expect(shell.args).toEqual(['uvx', 'mcp-shell-server']);
  });

  it('sandbox:false leaves the builtins unwrapped', () => {
    const [fs, shell] = resolveNativeTooling(
      { fs: true, shell: true },
      { cwd: '/p/a', sandbox: false }
    ) as [Stdio, Stdio];
    expect(fs.command).toBe('npx');
    expect(shell.command).toBe('uvx');
  });

  it('never wraps the dispatch self server (agent-mcp is the host, not a sandboxed tool)', () => {
    const servers = resolveNativeTooling(
      { fs: false, shell: false, dispatch: true },
      { cwd: '/p/a', dispatchSelf }
    );
    expect(servers).toEqual([dispatchSelf]);
  });

  // A4 / 535c1101: the host passes a per-run settings file; the resolver must
  // emit it as `srt -s <path> <cmd>` so the per-spawn cwd allow is not written
  // into the shared global policy.
  it('A4: `srtSettingsPath` emits an explicit `srt -s <path> …` for the wrapped builtins', () => {
    const [fs, shell] = resolveNativeTooling(
      { fs: true, shell: true },
      { cwd: '/p/a', srtSettingsPath: '/run/srt-run.json' }
    ) as [Stdio, Stdio];
    expect(fs.command).toBe('srt');
    expect(fs.args?.slice(0, 4)).toEqual(['-s', '/run/srt-run.json', 'npx', '-y']);
    expect(shell.command).toBe('srt');
    expect(shell.args?.slice(0, 3)).toEqual(['-s', '/run/srt-run.json', 'uvx']);
  });

  it('A4: with no `srtSettingsPath` the resolver emits a bare `srt` (pre-existing shape)', () => {
    const [fs] = resolveNativeTooling(
      { fs: true, shell: false },
      { cwd: '/p/a' }
    ) as [Stdio];
    expect(fs.command).toBe('srt');
    expect(fs.args?.[0]).toBe('npx'); // no `-s` prefix
  });
});
