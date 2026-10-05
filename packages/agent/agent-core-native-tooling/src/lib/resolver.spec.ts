import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from '@adhd/agent-base-types';
import { resolveNativeTooling } from './resolver.js';

const dispatchSelf: McpServerConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@adhd/agent-mcp@latest'],
};

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
const stdio = (servers: McpServerConfig[]): Stdio[] =>
  servers.filter((s): s is Stdio => s.transport === 'stdio');

const fsServer = (servers: McpServerConfig[]): Stdio | undefined =>
  stdio(servers).find((s) => s.args?.includes('@modelcontextprotocol/server-filesystem'));

const shellServer = (servers: McpServerConfig[]): Stdio | undefined =>
  stdio(servers).find((s) => s.command === 'uvx');

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

  it('a custom McpServerConfig REPLACES the builtin (D3)', () => {
    const custom: McpServerConfig = { transport: 'stdio', command: 'my-fs', args: ['--root', '/x'] };
    const servers = resolveNativeTooling({ fs: custom, shell: false, dispatch: false }, { cwd: '/p/a' });
    expect(servers).toEqual([custom]);
  });

  it('shell allowCommands/denyCommands/timeoutMs become adopted-server env passthrough', () => {
    const servers = resolveNativeTooling(
      { fs: false, shell: { allowCommands: ['ls', 'git'], denyCommands: ['rm'], timeoutMs: 45_000 } },
      { cwd: '/p/a' }
    );
    const shell = shellServer(servers)!;
    expect(shell.env?.ALLOW_COMMANDS).toBe('ls,git');
    expect(shell.env?.DENY_COMMANDS).toBe('rm');
    expect(shell.env?.MCP_SHELL_DEFAULT_TIMEOUT_SECONDS).toBe('45');
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
