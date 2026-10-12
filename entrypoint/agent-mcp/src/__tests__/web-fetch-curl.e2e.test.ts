/**
 * R5-WEB-SIMPLE AC3 — a default agent-mcp shell fetches a public web page with `curl`, driven
 * through the REAL unmodified `mcp-shell-server` (`uvx`), the REAL `srt` sandbox and the REAL
 * agent-mcp run policy (`provisionRunSrtPolicy` + the open-egress proxy + the exit-status shim),
 * speaking MCP JSON-RPC over stdio exactly as the engine's MCP client does. Nothing under test is
 * mocked or imported-and-called around the server.
 *
 * Why this exists: on arm C of the parity run the default shell had no `curl` and `srt` only
 * allowed PyPI, so a model on any provider could not fetch a page. This suite is the zero-model
 * preflight for that path.
 *
 * Network: `https://example.com` is a public third-party site, not a paid service, so this suite is
 * NOT env-gated (ADR-0009 / AGENTS.md "Live testing is mandatory"). A missing `curl`/`srt`/`uvx`
 * or an unreachable network turns the suite RED — there is no skip.
 *
 * Teeth: the negative control provisions the SAME run policy WITHOUT the open-egress proxy
 * (`restricted`: PyPI-only srt filter, i.e. the previous default) and the same https fetch must
 * exit non-zero with the `[exit status: N]` trailer. If the open mode were not what makes the
 * positive test pass, the control would also pass and go red.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@adhd/agent-base-types';
import { resolveNativeTooling } from '@adhd/agent-core-native-tooling';
import { buildNativeToolingContext } from '../defaults.js';
import { startOpenEgressProxy, type OpenEgressProxy } from '../egress-proxy.js';
import { SRT_SETTINGS_ENV, provisionRunSrtPolicy, removeRunSrtPolicy } from '../srt-policy.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const REPO_BIN = join(REPO_ROOT, 'node_modules', '.bin');
const SPAWN_PATH = `${REPO_BIN}${delimiter}${process.env.PATH ?? ''}`;
const STARTUP_MS = 120_000; // cold uvx resolution of mcp-shell-server
const CALL_MS = 60_000;
const TEST_MS = STARTUP_MS + CALL_MS + 30_000;
const TRAILER = /\[exit status: (\d+)\]/;

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
// The harness lives in the native-tooling package's test dir (not exported); reuse it by path.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { RpcClient, TEARDOWN_GRACE_MS } from '../../../../packages/agent/agent-core-native-tooling/src/test/rpc-harness.js';

const PROXY_VAR = /^(https?|all|ftp|no)_proxy$/i;
const hostEnvWithoutProxy = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !PROXY_VAR.test(k)));

let root: string;
let cwd: string;
let fakeHome: string;
let shimRoot: string;
let proxy: OpenEgressProxy;
const clients: InstanceType<typeof RpcClient>[] = [];

function requireBinary(name: string, args: string[]): void {
  const r = spawnSync(name, args, { env: { ...hostEnvWithoutProxy(), PATH: SPAWN_PATH }, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`R5-WEB-SIMPLE e2e prerequisite missing: \`${name} ${args.join(' ')}\` failed (${r.error?.message ?? `exit ${r.status}`}). This suite never skips — install it.`);
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-mcp-web-fetch-')));
  cwd = join(root, 'cwd');
  fakeHome = join(root, 'home');
  mkdirSync(cwd);
  mkdirSync(fakeHome);
  requireBinary('srt', ['--version']);
  requireBinary('uvx', ['--version']);
  requireBinary('curl', ['--version']);
  if (process.platform === 'linux') {
    requireBinary('bwrap', ['--version']);
    requireBinary('socat', ['-V']);
  }
  shimRoot = join(REPO_ROOT, 'tmp', 'agent-mcp', `web-fetch-shim-${process.pid}`);
  proxy = await startOpenEgressProxy();
}, STARTUP_MS);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  removeRunSrtPolicy();
  await proxy?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  if (shimRoot && existsSync(shimRoot)) {
    for (const entry of readdirSync(shimRoot)) chmodSync(join(shimRoot, entry), 0o755);
    rmSync(shimRoot, { recursive: true, force: true });
  }
}, 4 * TEARDOWN_GRACE_MS);

/** Provision the agent-mcp run policy (open when `port` is given) and spawn the DEFAULT shell as the engine would. */
async function startDefaultShell(name: string, port: number | undefined, operatorPolicy?: object): Promise<InstanceType<typeof RpcClient>> {
  const policyPath = join(root, `${name}-srt-policy.json`);
  if (operatorPolicy) writeFileSync(policyPath, JSON.stringify(operatorPolicy));
  const env = { ...process.env, [SRT_SETTINGS_ENV]: policyPath };
  provisionRunSrtPolicy(cwd, env, undefined, port);
  const ctx = buildNativeToolingContext({ cwd, exitShimRoot: shimRoot });
  // No shell overrides: the shipped defaults (allowlist incl. curl) are what is under test.
  const [shell] = resolveNativeTooling({ fs: false, dispatch: false }, ctx) as Stdio[];
  expect(shell.command).toBe('srt');
  const realHome = homedir();
  const child = spawn(shell.command, shell.args ?? [], {
    cwd,
    detached: true,
    env: {
      ...hostEnvWithoutProxy(),
      PATH: SPAWN_PATH,
      HOME: fakeHome,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(realHome, '.cache', 'uv'),
      UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? join(realHome, '.local', 'share', 'uv', 'python'),
      ...(shell.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new RpcClient(child);
  clients.push(client);
  await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'web-fetch-e2e', version: '1' } }, STARTUP_MS);
  client.notify('notifications/initialized');
  return client;
}

async function shell(client: InstanceType<typeof RpcClient>, command: string[]): Promise<string> {
  const r = await client.request('tools/call', { name: 'shell_execute', arguments: { command, timeout: 30 } }, CALL_MS);
  const blocks = r?.result?.content;
  return Array.isArray(blocks) ? blocks.map((b: { text?: string }) => b.text ?? '').join('\n') : JSON.stringify(r);
}

describe('R5-WEB-SIMPLE the default shell can curl a public page', () => {
  it('R5-WEB-SIMPLE AC1 AC2 AC3: curl -fsSL https://example.com returns the page body (no failing exit trailer)', async () => {
    const c = await startDefaultShell('open', proxy.port);
    const out = await shell(c, ['curl', '-fsSL', '--max-time', '20', 'https://example.com']);
    expect(out).toContain('Example Domain');
    // The shim reports a status only when the command did not succeed (observed against the real server).
    expect(out.match(TRAILER)?.[1] ?? '0').toBe('0');
  }, TEST_MS);

  it('R5-WEB-SIMPLE AC1 AC3: plain http:// and the `| head` pipe form work through the same shell', async () => {
    const c = await startDefaultShell('open-http', proxy.port);
    const out = await shell(c, ['curl', '-sL', '--max-time', '20', 'http://example.com', '|', 'head', '-c', '60']);
    expect(out.toLowerCase()).toContain('<!doctype html>');
  }, TEST_MS);

  it('R5-WEB-SIMPLE AC2: a failing fetch (unresolvable host) surfaces a non-zero exit status, never an empty success', async () => {
    const c = await startDefaultShell('open-dead', proxy.port);
    const out = await shell(c, ['curl', '-sS', '--max-time', '20', 'https://no-such-host.invalid']);
    const n = out.match(TRAILER)?.[1];
    expect(n, out).toBeDefined();
    expect(Number(n)).not.toBe(0);
  }, TEST_MS);

  it('R5-WEB-SIMPLE AC3 negative control: with egress closed (PyPI-only srt filter) the same https fetch exits non-zero with the trailer', async () => {
    const c = await startDefaultShell('closed', undefined);
    const out = await shell(c, ['curl', '-sS', '--max-time', '20', 'https://example.com']);
    expect(out).not.toContain('Example Domain');
    const n = out.match(TRAILER)?.[1];
    expect(n, out).toBeDefined();
    expect(Number(n)).not.toBe(0);
  }, TEST_MS);

  it('R5-WEB-SIMPLE AC2 AC3 negative control via config: an operator-pinned policy naming a domain keeps srt\'s filter even WITH the open proxy offered', async () => {
    const operator = {
      network: { allowedDomains: ['example.org'], deniedDomains: [] },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    };
    const c = await startDefaultShell('pinned', proxy.port, operator);
    const out = await shell(c, ['curl', '-sS', '--max-time', '20', 'https://example.com']);
    expect(out).not.toContain('Example Domain');
    const n = out.match(TRAILER)?.[1];
    expect(n, out).toBeDefined();
    expect(Number(n)).not.toBe(0);
  }, TEST_MS);
});
