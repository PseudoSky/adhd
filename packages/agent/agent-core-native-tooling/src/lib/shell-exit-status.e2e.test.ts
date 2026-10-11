/**
 * 61358b6f AC1-AC3, AC5-AC7, AC11, AC12 — shell exit status through the REAL `srt`
 * sandbox and the REAL, UNMODIFIED adopted `mcp-shell-server` (`uvx --from
 * mcp-shell-server==1.1.12`), driven by a real MCP stdio client.
 *
 * Bug: the adopted server computes each command's exit status and drops it, so
 * `false` returns `content: []` / `isError: false` and a failing `ls` is
 * indistinguishable from a successful one. The owner constraint is NO fork and NO
 * patch of the server, so `resolveNativeTooling({ exitShim })` puts a read-only
 * launcher directory first on the server's `PATH` (`exit-shim.ts`); the launcher
 * appends `[exit status: N]` to stderr on a non-zero exit.
 *
 * What the test drives: `prepareExitShimDir` + `resolveNativeTooling` (this
 * package's public entry) produce the exact `command`/`args`/`env` a host would
 * spawn; this file spawns that under `srt`, speaks MCP JSON-RPC over stdio like a
 * host and calls `shell_execute`.
 *
 * Teeth (AC12): the `control` case strips `PATH` from the resolved env (so the
 * shim is not first on the server's PATH) and asserts the AC1 assertion FAILS —
 * the suite goes red if the shim wiring is removed.
 *
 * No env gate, no skip: a missing `srt`/`uvx` fails loudly (beforeAll). Lane:
 * ADR-0009 (`e2e`, `nx run agent-core-native-tooling:e2e`). Own isolated cwd +
 * fake HOME; no paid third-party service.
 *
 * The shim directory lives under the repo `tmp/` (outside every srt `allowWrite`
 * root) and is also listed in the policy's `denyWrite`.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@adhd/agent-base-types';
import { prepareExitShimDir } from './exit-shim.js';
import { resolveNativeTooling } from './resolver.js';
import { RpcClient, TEARDOWN_GRACE_MS } from '../test/rpc-harness.js';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const REPO_BIN = join(REPO_ROOT, 'node_modules/.bin');
const STARTUP_MS = 120_000; // cold uvx resolution of mcp-shell-server
const CALL_MS = 60_000; // one shell_execute round trip
const TEST_MS = STARTUP_MS + CALL_MS + 30_000;
const SENTINEL = /\[exit status: (\d+)\]/;

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;

let root: string;
let cwd: string;
let fakeHome: string;
let settingsPath: string;
let shimRoot: string;
let shimDir: string;
const clients: RpcClient[] = [];

const PROXY_VAR = /^(https?|all|ftp|no)_proxy$/i;
function hostEnvWithoutProxy(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !PROXY_VAR.test(k)));
}

/** The PATH every spawn uses (repo `.bin` first), so prerequisites resolve exactly as the server does. */
const SPAWN_PATH = `${REPO_BIN}${delimiter}${process.env.PATH ?? ''}`;

function requireBinary(name: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(name, args, { env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(
      `61358b6f e2e prerequisite missing: \`${name} ${args.join(' ')}\` failed ` +
        `(${r.error?.message ?? `exit ${r.status}`}). This suite never skips — install it.`
    );
  }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-tooling-exitstatus-')));
  cwd = join(root, 'cwd');
  fakeHome = join(root, 'home');
  mkdirSync(cwd);
  mkdirSync(fakeHome);

  const env = { ...hostEnvWithoutProxy(), PATH: SPAWN_PATH };
  requireBinary('srt', ['--version'], env);
  requireBinary('uvx', ['--version'], env);
  if (process.platform === 'linux') {
    requireBinary('bwrap', ['--version'], env);
    requireBinary('socat', ['-V'], env);
  }

  // Outside every srt allowWrite root: the repo tree is not writable to the sandbox.
  shimRoot = join(REPO_ROOT, 'tmp', 'agent-core-native-tooling', `exit-shim-e2e-${process.pid}`);
  shimDir = prepareExitShimDir({ origPath: SPAWN_PATH, rootDir: shimRoot }).dir;

  const realHome = homedir();
  settingsPath = join(root, 'srt-policy.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      network: {
        allowedDomains: ['pypi.org', '*.pypi.org', 'files.pythonhosted.org'],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: [
          root,
          join(realHome, '.cache'),
          join(realHome, '.local', 'share'),
          join(realHome, 'Library', 'Caches'),
          realpathSync(tmpdir()),
          ...(process.platform === 'darwin' ? ['/private/var/folders', '/var/folders'] : []),
          '/tmp',
        ],
        denyWrite: [shimRoot],
      },
    })
  );
}, STARTUP_MS);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  if (root) rmSync(root, { recursive: true, force: true });
  if (shimRoot && existsSync(shimRoot)) {
    // The shim dirs are 0555: restore write permission so teardown can remove them.
    for (const entry of readdirSync(shimRoot)) chmodSync(join(shimRoot, entry), 0o755);
    rmSync(shimRoot, { recursive: true, force: true });
  }
}, 4 * TEARDOWN_GRACE_MS);

interface StartOptions {
  allowCommands?: string[];
  /** Resolve WITH the exit shim (default true). */
  shim?: boolean;
  /** Teeth: drop the resolved `PATH` so the shim is not on the server's PATH (AC12). */
  stripPath?: boolean;
}

/** Resolve the shell builtin exactly as a host does, then spawn it. */
async function startShell(opts: StartOptions = {}): Promise<RpcClient> {
  const [shell] = resolveNativeTooling(
    {
      fs: false,
      dispatch: false,
      shell: { allowCommands: opts.allowCommands ?? ['ls', 'false', 'echo', 'cat', 'sleep', 'touch'] },
    },
    {
      cwd,
      srtSettingsPath: settingsPath,
      ...(opts.shim === false ? {} : { exitShim: { dir: shimDir, origPath: SPAWN_PATH } }),
    }
  ) as Stdio[];
  expect(shell.command).toBe('srt');
  if (opts.stripPath) {
    const { PATH: _dropped, ...rest } = shell.env ?? {};
    shell.env = rest;
  }
  const realHome = homedir();
  const child = spawn(shell.command, shell.args ?? [], {
    cwd,
    detached: true,
    env: {
      ...hostEnvWithoutProxy(),
      PATH: SPAWN_PATH,
      HOME: fakeHome,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(realHome, '.cache', 'uv'),
      UV_PYTHON_INSTALL_DIR:
        process.env.UV_PYTHON_INSTALL_DIR ?? join(realHome, '.local', 'share', 'uv', 'python'),
      ...(shell.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new RpcClient(child);
  clients.push(client);
  await client.request(
    'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'exit-status-e2e', version: '1' } },
    STARTUP_MS
  );
  client.notify('notifications/initialized');
  return client;
}

async function shellExecute(client: RpcClient, command: string[], timeout?: number): Promise<any> {
  return client.request(
    'tools/call',
    { name: 'shell_execute', arguments: { command, ...(timeout ? { timeout } : {}) } },
    CALL_MS
  );
}

const contentOf = (r: any): Array<{ type: string; text: string }> => r?.result?.content ?? [];
const textOf = (r: any): string => contentOf(r).map((b) => b.text).join('\n');

/** AC1's assertion, as a predicate so the negative control can prove it has teeth. */
function ac1Holds(r: any, expectedStatus: number): boolean {
  const parts = contentOf(r);
  const last = parts[parts.length - 1]?.text ?? '';
  const m = SENTINEL.exec(last);
  return (
    r?.result?.isError === false &&
    m !== null &&
    Number(m[1]) === expectedStatus &&
    expectedStatus !== 0 &&
    parts.some((p) => /definitely-not-here/.test(p.text))
  );
}

function sleepProcessCount(marker: string): number {
  const ps = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  return ps.stdout.split('\n').filter((l) => l.trim() === marker).length;
}

describe('61358b6f shell exit status through real srt + real unmodified mcp-shell-server', () => {
  it(
    '61358b6f AC1: a failing command returns its stderr AND a final [exit status: N] equal to the real exit code; isError stays false',
    async () => {
      const expected = spawnSync('ls', ['/definitely-not-here'], { encoding: 'utf8' }).status;
      expect(expected).not.toBe(0);
      const r = await shellExecute(await startShell(), ['ls', '/definitely-not-here']);
      expect(ac1Holds(r, expected as number), JSON.stringify(r)).toBe(true);
    },
    TEST_MS
  );

  it(
    '61358b6f AC2: a silent failure returns exactly one part [exit status: 1] (was an empty content array)',
    async () => {
      const client = await startShell();
      const r = await shellExecute(client, ['false']);
      expect(r.result.isError).toBe(false);
      expect(contentOf(r)).toHaveLength(1);
      expect(contentOf(r)[0].text.trim()).toBe('[exit status: 1]');
    },
    TEST_MS
  );

  it(
    '61358b6f AC3: a zero exit is byte-identical with and without the shim and carries no trailer',
    async () => {
      const shimmed = await shellExecute(await startShell(), ['echo', 'hi']);
      const control = await shellExecute(await startShell({ shim: false }), ['echo', 'hi']);
      expect(contentOf(shimmed)).toEqual([{ type: 'text', text: 'hi' }]);
      expect(contentOf(shimmed)).toEqual(contentOf(control));
      expect(shimmed.result.isError).toBe(control.result.isError);
    },
    TEST_MS
  );

  it(
    '61358b6f AC3: stdin is forwarded through the launcher (a pipeline segment still reads its input)',
    async () => {
      const cmd = ['echo', 'piped-through', '|', 'cat'];
      const r = await shellExecute(await startShell(), cmd);
      const control = await shellExecute(await startShell({ shim: false }), cmd);
      expect(textOf(r)).toContain('piped-through');
      expect(contentOf(r)).toEqual(contentOf(control));
    },
    TEST_MS
  );

  it(
    '61358b6f AC5: the tool surface (name, inputSchema, description) equals the unshimmed control',
    async () => {
      const a = await (await startShell()).request('tools/list', {}, CALL_MS);
      const b = await (await startShell({ shim: false })).request('tools/list', {}, CALL_MS);
      expect(a.result.tools.length).toBeGreaterThan(0);
      // The server renders its allowed-command SET in per-process hash order; sort it.
      const normalise = (tools: any[]) =>
        JSON.parse(
          JSON.stringify(tools).replace(/Allowed commands: ([^\\]*)/g, (_m, list: string) =>
            `Allowed commands: ${list.split(', ').sort().join(', ')}`
          )
        );
      expect(normalise(a.result.tools)).toEqual(normalise(b.result.tools));
    },
    TEST_MS
  );

  it(
    '61358b6f AC6: the protected shim dir has no entry for uv/uvx/python*/srt/node/sh/env/bash/zsh and the server answers listTools',
    async () => {
      const names = readdirSync(shimDir);
      for (const protectedName of ['uv', 'uvx', 'srt', 'node', 'sh', 'env', 'bash', 'zsh']) {
        expect(names, protectedName).not.toContain(protectedName);
      }
      expect(names.filter((n) => n.startsWith('python'))).toEqual([]);
      expect(names).toContain('ls');
      const listed = await (await startShell()).request('tools/list', {}, CALL_MS);
      expect(listed.result.tools.map((t: any) => t.name)).toContain('shell_execute');
    },
    TEST_MS
  );

  it(
    '61358b6f AC4: the allowlist is untouched — a non-allowlisted command is still refused by the server and carries no trailer',
    async () => {
      const r = await shellExecute(await startShell({ allowCommands: ['echo'] }), ['rm', '-rf', '/definitely-not-here']);
      expect(textOf(r)).toMatch(/Command not allowed: rm/);
      expect(textOf(r)).not.toMatch(SENTINEL);
    },
    TEST_MS
  );

  it(
    '61358b6f AC7: a timed-out command is terminated through the launcher (no orphaned sleep)',
    async () => {
      const marker = 'sleep 31';
      expect(sleepProcessCount(marker)).toBe(0);
      const r = await shellExecute(await startShell(), ['sleep', '31'], 1);
      expect(textOf(r).toLowerCase()).toMatch(/timed out|timeout/);
      const deadline = Date.now() + 15_000;
      while (sleepProcessCount(marker) > 0 && Date.now() < deadline) {
        await new Promise((ok) => setTimeout(ok, 100));
      }
      expect(sleepProcessCount(marker)).toBe(0);
    },
    TEST_MS
  );

  it(
    '61358b6f: the sandboxed shell cannot plant a launcher into the shim directory',
    async () => {
      const planted = join(shimDir, 'planted');
      const r = await shellExecute(await startShell(), ['touch', planted]);
      expect(existsSync(planted)).toBe(false);
      expect(textOf(r)).toMatch(/\[exit status: [1-9]\d*\]/);
    },
    TEST_MS
  );

  it(
    '61358b6f AC11: an allowlist entry that is an absolute path bypasses PATH lookup, so it gets no trailer (documented gap)',
    async () => {
      const abs = ['/usr/bin/false', '/bin/false'].find((p) => existsSync(p));
      expect(abs, 'no absolute false binary on this host').toBeDefined();
      const r = await shellExecute(await startShell({ allowCommands: [abs as string] }), [abs as string]);
      expect(r.result.isError).toBe(false);
      expect(textOf(r)).not.toMatch(SENTINEL);
    },
    TEST_MS
  );

  it(
    '61358b6f AC12 control: with PATH stripped from the resolved env (shim off the PATH) the AC1 assertion FAILS',
    async () => {
      const expected = spawnSync('ls', ['/definitely-not-here'], { encoding: 'utf8' }).status as number;
      const r = await shellExecute(await startShell({ stripPath: true }), ['ls', '/definitely-not-here']);
      expect(ac1Holds(r, expected), JSON.stringify(r)).toBe(false);
      expect(textOf(r)).not.toMatch(SENTINEL);
    },
    TEST_MS
  );
});
