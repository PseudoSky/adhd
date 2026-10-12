/**
 * 61358b6f (S1 follow-through for 7f779174 / 069316e5) — every name in
 * `DEFAULT_SHELL_ALLOW_COMMANDS` is ACCEPTED by the REAL adopted
 * `mcp-shell-server==1.1.12` under its default security policy.
 *
 * Bug: the first default list advertised `sed`, `node` and `python3`, which the
 * server rejects as "Command rejected by default security policy" even when
 * allowlisted (its `DANGEROUS_COMMANDS`), so the model was told it could run
 * commands that always fail. This suite resolves the default exactly as a host
 * does (`resolveNativeTooling`, no `allowCommands`), spawns the server and calls
 * each default entry once, asserting none is policy-rejected or not-allowed.
 *
 * It ITERATES the list: a newly added name needs an entry in `PROBE_ARGV` (the
 * suite fails loudly otherwise) and is then checked against the real server, so a
 * rejected name cannot be re-added silently. A binary that is merely absent from
 * the host (`Failed to create process`) is not a policy rejection and passes.
 *
 * No srt (the policy under test is the server's own); `uvx` must exist — a missing
 * prerequisite fails loudly, never skips. Lane: ADR-0009 (`e2e`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@adhd/agent-base-types';
import { DEFAULT_SHELL_ALLOW_COMMANDS } from './catalog.js';
import { resolveNativeTooling } from './resolver.js';
import { RpcClient } from '../test/rpc-harness.js';

const STARTUP_MS = 120_000;
const CALL_MS = 60_000;
const NX = '/definitely-not-here-61358b6f';
const POLICY_REJECTION = /rejected by default security policy|Command not allowed/;

/** One harmless, side-effect-free argv per default command (all targets are nonexistent). */
const PROBE_ARGV: Record<string, string[]> = {
  cat: [NX], ls: [NX], cp: [`${NX}a`, `${NX}b`], mv: [`${NX}a`, `${NX}b`], mkdir: [`${NX}/x`],
  rm: [NX], touch: [`${NX}/x`], head: [NX], tail: [NX], wc: [NX], sort: [NX], uniq: [NX],
  tr: ['a', 'b'], cut: ['-f1', NX], diff: [`${NX}a`, `${NX}b`], awk: ['BEGIN{print 1}'],
  grep: ['x', NX], rg: ['x', NX], echo: ['hi'], printf: ['hi'], pwd: [], test: ['-e', NX],
  true: [], false: [], basename: ['/a/b'], dirname: ['/a/b'], realpath: [NX], stat: [NX],
  tee: [`${NX}/x`], chmod: ['644', NX], git: ['--version'], npm: ['--version'],
  pnpm: ['--version'], npx: ['--version'], nx: ['--version'], make: ['--version'],
  tsc: ['--version'], uv: ['--version'], curl: ['--version'],
};

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
let root: string;
let client: RpcClient;

beforeAll(async () => {
  const path = `${resolve(__dirname, '../../../../../node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`;
  const r = spawnSync('uvx', ['--version'], { env: { ...process.env, PATH: path }, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`61358b6f e2e prerequisite missing: \`uvx --version\` failed (${r.error?.message ?? `exit ${r.status}`}). This suite never skips — install it.`);
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-tooling-defaults-')));
  const [shell] = resolveNativeTooling({ fs: false, dispatch: false }, { cwd: root, sandbox: false }) as Stdio[];
  const child = spawn(shell.command, shell.args ?? [], {
    cwd: root,
    detached: true,
    env: { ...process.env, PATH: path, ...(shell.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  client = new RpcClient(child);
  await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'defaults-e2e', version: '1' } }, STARTUP_MS);
  client.notify('notifications/initialized');
}, STARTUP_MS + 10_000);

afterAll(async () => {
  await client?.close();
  if (root) rmSync(root, { recursive: true, force: true });
}, 30_000);

describe('61358b6f every DEFAULT_SHELL_ALLOW_COMMANDS entry is accepted by the real mcp-shell-server', () => {
  it('has a probe argv for every default (a new default must add one)', () => {
    expect(DEFAULT_SHELL_ALLOW_COMMANDS.filter((c) => !(c in PROBE_ARGV))).toEqual([]);
    expect(Object.keys(PROBE_ARGV).filter((c) => !DEFAULT_SHELL_ALLOW_COMMANDS.includes(c))).toEqual([]);
  });

  for (const name of DEFAULT_SHELL_ALLOW_COMMANDS) {
    it(`61358b6f: default '${name}' is not rejected by the server's default security policy`, async () => {
      const r = await client.request(
        'tools/call',
        { name: 'shell_execute', arguments: { command: [name, ...(PROBE_ARGV[name] ?? [])], timeout: 8 } },
        CALL_MS
      );
      const text = (r.result?.content ?? []).map((b: { text?: string }) => b.text ?? '').join('\n');
      expect(text).not.toMatch(POLICY_REJECTION);
    }, CALL_MS + 10_000);
  }

  it('R5-WEB-SIMPLE AC1: the real server runs curl, `curl | head` and `curl -o` / `curl > file` (| and > as argv items) and returns the body', async () => {
    const BODY = 'PROBE-BODY-0123456789-abcdefghij';
    const web = createServer((_req, res) => res.end(BODY));
    await new Promise<void>((ok) => web.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/`;
    const call = async (command: string[]): Promise<string> => {
      const r = await client.request('tools/call', { name: 'shell_execute', arguments: { command, timeout: 8 } }, CALL_MS);
      expect(r.result?.isError, JSON.stringify(r)).toBe(false);
      return (r.result?.content ?? []).map((b: { text?: string }) => b.text ?? '').join('\n');
    };
    try {
      expect(await call(['curl', '-sL', url])).toBe(BODY);
      expect(await call(['curl', '-sL', url, '|', 'head', '-c', '10'])).toBe('PROBE-BODY');
      await call(['curl', '-sL', '-o', 'out.html', url]);
      expect(await call(['cat', 'out.html'])).toBe(BODY);
      await call(['curl', '-sL', url, '>', 'out2.html']);
      expect(await call(['cat', 'out2.html'])).toBe(BODY);
    } finally {
      await new Promise<void>((ok) => web.close(() => ok()));
    }
  }, CALL_MS * 8);

  it('61358b6f control: the server DOES reject sed, node and python3 (the entries this list used to carry)', async () => {
    // Teeth: the probe can see a policy rejection. These need an allowlist that includes them.
    const [shell] = resolveNativeTooling(
      { fs: false, dispatch: false, shell: { allowCommands: ['sed', 'node', 'python3'] } },
      { cwd: root, sandbox: false }
    ) as Stdio[];
    const path = `${resolve(__dirname, '../../../../../node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`;
    const child = spawn(shell.command, shell.args ?? [], {
      cwd: root, detached: true, env: { ...process.env, PATH: path, ...(shell.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rejecting = new RpcClient(child);
    try {
      await rejecting.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'defaults-e2e-control', version: '1' } }, STARTUP_MS);
      rejecting.notify('notifications/initialized');
      for (const argv of [['sed', 'p', NX], ['node', '--version'], ['python3', '--version']]) {
        const r = await rejecting.request('tools/call', { name: 'shell_execute', arguments: { command: argv, timeout: 8 } }, CALL_MS);
        const text = (r.result?.content ?? []).map((b: { text?: string }) => b.text ?? '').join('\n');
        expect(text, argv[0]).toMatch(/rejected by default security policy/);
      }
    } finally {
      await rejecting.close();
    }
  }, STARTUP_MS + CALL_MS * 3);
});
