/**
 * 0ba70e47 AC1 / AC3b — shell egress through the REAL `srt` sandbox and the
 * REAL adopted `mcp-shell-server` (`uvx --from mcp-shell-server==1.1.12`).
 *
 * Bug: the adopted server hands each spawned command `PATH` only, so the proxy
 * variables `srt` injects never reached `curl` and every allowlisted network
 * call failed DNS inside the sandbox (`curl: (6) Could not resolve host`, and
 * with `-s` the tool returned `content: []`). `resolveShell` now emits
 * `MCP_SHELL_CHILD_ENV_ALLOWLIST`.
 *
 * What the test drives: `resolveNativeTooling` (this package's public entry)
 * produces the exact `command`/`args`/`env` a host would spawn; this file
 * spawns that, speaks MCP JSON-RPC over stdio like a host, and calls
 * `shell_execute curl -s http://allowed.test/`.
 *
 * Why the "local server" is the sandbox's PARENT PROXY, not a directly curled
 * port: `srt` refuses any destination that resolves to one of the host's own
 * addresses ("Connection to … blocked: resolved to one of this host's
 * addresses") and its injected NO_PROXY bypasses the proxy for localhost and
 * private ranges (which the seatbelt/bwrap layer then blocks), so a loopback
 * target can never be reached from inside `srt` by design. `srt`'s documented
 * `network.parentProxy` setting chains its egress proxy through an upstream
 * proxy; here that upstream is a LOCAL HTTP server on an ephemeral port that
 * answers every request with a known body. The request therefore travels
 * curl -> srt proxy (domain allowlist: only `allowed.test`) -> local server,
 * and it only starts if the child env carries the proxy variables.
 *
 * Teeth: the `control` test strips the allowlist from the resolved env and
 * asserts the SAME call no longer returns the body (a failure of any kind) — so the
 * suite goes red if the env line is ever removed or the server stops honouring
 * it. No env gate, no skip: a missing `srt`/`uvx` fails loudly (beforeAll).
 *
 * Linux note (UNVERIFIED here — written defensively, never run on Linux):
 * `requireBinary` also demands `bwrap` and `socat` on Linux so a missing
 * prerequisite fails loudly; the macOS-only `/private/var/folders` and
 * `/var/folders` write paths are added only on darwin. Whether srt's bwrap
 * layer needs further Linux-specific policy is untested.
 *
 * Credential claim (0ba70e47 AC3b): a third case spawns the server with a credentialed
 * host HTTP(S)/ALL_PROXY and asserts `printenv` inside the sandbox shows only srt's own
 * proxy variables and never the host secret (proven red against the inverted assertion).
 *
 * Determinism: host `*_PROXY` / `NO_PROXY` variables are stripped from every
 * spawn env except in the credential case, which injects them on purpose; the policy's `parentProxy`/`noProxy` are the only proxy inputs.
 * Timeouts: each test's budget (`TEST_MS`) is strictly longer than the sum of
 * its inner bounded waits (initialize + tools/call), so the informative
 * RpcClient error (with server stderr) always fires before vitest's generic one.
 *
 * Lane: ADR-0009 (`e2e`, `nx run agent-core-native-tooling:e2e`). Own isolated
 * cwd + fake HOME; no paid third-party service.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@adhd/agent-base-types';
import { resolveNativeTooling } from './resolver.js';

const BODY = 'E2E-0ba70e47-BODY';
const ALLOWED_HOST = 'allowed.test';
const REPO_BIN = resolve(__dirname, '../../../../../node_modules/.bin');
const STARTUP_MS = 120_000; // cold uvx resolution of mcp-shell-server
const CALL_MS = 60_000; // one shell_execute round trip
const TEARDOWN_GRACE_MS = 5_000; // SIGTERM -> SIGKILL escalation deadline
/** Per-test budget: strictly longer than initialize + tools/call (+ margin for spawn). */
const TEST_MS = STARTUP_MS + CALL_MS + 30_000;

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;

/** Minimal MCP stdio client: newline-delimited JSON-RPC, bounded waits. */
class RpcClient {
  private buf = '';
  private pending = new Map<number, { res: (m: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private stderr = '';
  /** stdout lines that were not valid JSON-RPC: kept for failure messages, otherwise ignored. */
  private readonly diagnostics: string[] = [];
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private hasExited = false;
  /** Set once the child can never answer again (spawn failure or exit); every request rejects with it. */
  private fatal?: Error;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise<void>((ok) => (this.resolveExited = ok));
    // Spawn failure (ENOENT/EACCES/...): Node emits 'error' and NEVER 'exit'.
    child.once('error', (err) => this.die(new Error(`failed to spawn server: ${err.message}`)));
    // One shared exit hook for the client's lifetime (no per-request listeners to leak).
    child.once('exit', (code, signal) => this.die(new Error(`server exited (${code ?? signal})`)));
    child.stdin.on('error', (err) => this.diagnostics.push(`stdin error: ${err.message}`));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (this.stderr += d));
    child.stdout.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === '') continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.diagnostics.push(line);
          continue;
        }
        if (msg && typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            p.res(msg);
          }
        }
      }
    });
  }
  private context(): string {
    return (
      `server stderr:\n${this.stderr}\nnon-JSON stdout lines:\n${this.diagnostics.join('\n')}`
    );
  }
  private die(err: Error): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.fatal = err;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.rej(new Error(`${err.message} before answering request #${id}; ${this.context()}`));
    }
    this.resolveExited();
  }
  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.fatal) return Promise.reject(new Error(`${this.fatal.message}; cannot send ${method}; ${this.context()}`));
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} timed out after ${timeoutMs}ms; ${this.context()}`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
  /** Signal the whole process group (srt wrapper + uvx/python/bwrap grandchildren); ESRCH ignored. */
  private signalGroup(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        this.child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  }
  /** Await the wrapper's exit: SIGTERM the group, escalate to SIGKILL after a bounded deadline. */
  async close(): Promise<void> {
    if (this.hasExited) return; // spawn failure / already exited: no exit event will ever come
    this.child.stdin.end();
    this.signalGroup('SIGTERM');
    const timer = setTimeout(() => this.signalGroup('SIGKILL'), TEARDOWN_GRACE_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

let root: string;
let cwd: string;
let fakeHome: string;
let settingsPath: string;
let upstream: Server;
const clients: RpcClient[] = [];

/** Host proxy variables must never leak into the spawn env (srt falls back to them). */
const PROXY_VAR = /^(https?|all|ftp|no)_proxy$/i;
function hostEnvWithoutProxy(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !PROXY_VAR.test(k)));
}

/** The PATH every spawn in this file uses (repo `.bin` first), so prerequisites resolve exactly as the server does. */
const SPAWN_PATH = `${REPO_BIN}${delimiter}${process.env.PATH ?? ''}`;

function requireBinary(name: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(name, args, { env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(
      `0ba70e47 e2e prerequisite missing: \`${name} ${args.join(' ')}\` failed ` +
        `(${r.error?.message ?? `exit ${r.status}`}). This suite never skips — install it.`
    );
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-tooling-egress-')));
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

  // The local "internet": answers every proxied request with a known body.
  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(BODY.length) });
    res.end(BODY);
  });
  await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
  const port = (upstream.address() as AddressInfo).port;

  const realHome = homedir();
  settingsPath = join(root, 'srt-policy.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      network: {
        // Only the fake host plus what a cold `uvx` needs. Everything else is denied.
        allowedDomains: [ALLOWED_HOST, 'pypi.org', '*.pypi.org', 'files.pythonhosted.org'],
        deniedDomains: [],
        // ALL of srt's egress chains through the parent, so the registry hosts a
        // cold `uvx` needs are exempted (noProxy -> direct); only `allowed.test`
        // lands on the local server.
        parentProxy: { http: `http://127.0.0.1:${port}`, noProxy: 'pypi.org,pythonhosted.org' },
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
        denyWrite: [],
      },
    })
  );
}, STARTUP_MS);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await new Promise<void>((ok) => (upstream ? upstream.close(() => ok()) : ok()));
  if (root) rmSync(root, { recursive: true, force: true });
}, 4 * TEARDOWN_GRACE_MS);

/** Resolve the shell builtin exactly as a host does, then spawn it. */
async function startShell(
  mutate?: (cfg: Stdio) => void,
  opts: { allowCommands?: string[]; hostEnv?: NodeJS.ProcessEnv } = {}
): Promise<RpcClient> {
  const [shell] = resolveNativeTooling(
    { fs: false, dispatch: false, shell: { allowCommands: opts.allowCommands ?? ['curl'] } },
    { cwd, srtSettingsPath: settingsPath }
  ) as Stdio[];
  expect(shell.command).toBe('srt'); // sandbox on by default
  mutate?.(shell);
  const realHome = homedir();
  const child = spawn(shell.command, shell.args ?? [], {
    cwd,
    detached: true, // own process group so teardown can signal grandchildren
    env: {
      ...hostEnvWithoutProxy(),
      ...(opts.hostEnv ?? {}),
      PATH: SPAWN_PATH,
      HOME: fakeHome,
      // Keep uv's caches shared so the suite does not re-download per run.
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(realHome, '.cache', 'uv'),
      UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? join(realHome, '.local', 'share', 'uv', 'python'),
      ...(shell.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new RpcClient(child);
  clients.push(client);
  await client.request(
    'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'egress-e2e', version: '1' } },
    STARTUP_MS
  );
  client.notify('notifications/initialized');
  return client;
}

async function shellExecute(client: RpcClient, command: string[]): Promise<any> {
  return client.request('tools/call', { name: 'shell_execute', arguments: { command } }, CALL_MS);
}

async function curl(client: RpcClient): Promise<any> {
  return shellExecute(client, ['curl', '-sS', '--max-time', '20', `http://${ALLOWED_HOST}/`]);
}

/** The text a host would show for a tool result: every content block's text, or the raw error payload. */
function toolText(r: any): string {
  const blocks = r?.result?.content;
  return Array.isArray(blocks) ? blocks.map((b: any) => String(b?.text ?? '')).join('\n') : JSON.stringify(r);
}

describe('0ba70e47 shell egress through real srt + real mcp-shell-server', () => {
  it(
    '0ba70e47 AC1 AC3b: shell_execute curl returns the page body (proxy env reaches the child)',
    async () => {
      const out = toolText(await curl(await startShell()));
      expect(out).toContain(BODY);
    },
    TEST_MS
  );

  it(
    '0ba70e47 AC3b control: without MCP_SHELL_CHILD_ENV_ALLOWLIST the same call does not return the page',
    async () => {
      const r = await curl(
        await startShell((cfg) => {
          const { MCP_SHELL_CHILD_ENV_ALLOWLIST: _dropped, ...rest } = cfg.env ?? {};
          cfg.env = rest;
        })
      );
      const out = toolText(r);
      // Failure of ANY kind counts: the page is absent. Never gate on one curl/seatbelt wording.
      expect(out).not.toContain(BODY);
      // Diagnostic only (non-fatal): known curl/seatbelt failure texts, so a reader can tell WHY it failed.
      const known = /Could not resolve host|Couldn't resolve host|Operation not permitted|Connection refused|Failed to connect|timed out/i;
      if (!known.test(out)) console.warn(`0ba70e47 control: failed without a recognised curl failure text; output was: ${out}`);
    },
    TEST_MS
  );

  it(
    '0ba70e47 AC3b: a host HTTP_PROXY / HTTPS_PROXY / ALL_PROXY carrying credentials never reaches the shell child (srt overwrites them)',
    async () => {
      const SECRET = 'SECRET-TOKEN-123';
      const hostProxy = `http://user:${SECRET}@127.0.0.1:9`;
      const hostEnv = {
        HTTP_PROXY: hostProxy,
        HTTPS_PROXY: hostProxy,
        ALL_PROXY: hostProxy,
        http_proxy: hostProxy,
        https_proxy: hostProxy,
        all_proxy: hostProxy,
      };
      const client = await startShell(undefined, { allowCommands: ['printenv'], hostEnv });
      const out = toolText(await shellExecute(client, ['printenv']));
      // Teeth: the child DID receive proxy variables (the passthrough works) and they
      // are srt's own (`srt.<id>:<token>@localhost:<port>`), not the host's ...
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        expect(out, key).toMatch(new RegExp(`^${key}=http://srt\\.[^@\\s]+@localhost:\\d+$`, 'm'));
      }
      // ... and nothing of the host's credentialed value survives.
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain('user:');
      expect(out).not.toMatch(/127\.0\.0\.1:9(\D|$)/);
    },
    TEST_MS
  );
});

/**
 * RpcClient robustness (0ba70e47 AC3b review F2/F3/F4). Real child processes, no
 * sleeps: each case settles on a process event.
 */
describe('0ba70e47 RpcClient harness fails informatively', () => {
  const spawnNode = (script: string) =>
    spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });

  it('0ba70e47 AC3b: a spawn failure (ENOENT) rejects the pending request with the error and close() resolves', async () => {
    const child = spawn('no-such-binary-0ba70e47', [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: SPAWN_PATH } });
    const client = new RpcClient(child);
    await expect(client.request('initialize', {}, 10_000)).rejects.toThrow(/failed to spawn server: .*ENOENT/);
    // later requests fail fast with the same fatal error instead of hanging to the timeout
    await expect(client.request('tools/call', {}, 10_000)).rejects.toThrow(/ENOENT/);
    await client.close(); // no 'exit' will ever come; must still resolve
  });

  it('0ba70e47 AC3b: a non-JSON stdout line is ignored and the real response still resolves', async () => {
    const client = new RpcClient(
      spawnNode(
        `process.stdin.once('data', () => { console.log('{broken json'); console.log('plain banner');
         console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })); setTimeout(() => process.exit(0), 50); });`
      )
    );
    const r = await client.request('ping', {}, 10_000);
    expect(r.result).toEqual({ ok: true });
    await client.close();
  });

  it('0ba70e47 AC3b: when the server dies after emitting garbage, the rejection carries the garbage and stderr', async () => {
    const client = new RpcClient(
      spawnNode(
        `process.stdin.once('data', () => { console.log('{broken json'); console.error('boom-on-stderr'); process.exit(3); });`
      )
    );
    const err: Error = await client.request('ping', {}, 10_000).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e
    );
    expect(err.message).toMatch(/server exited \(3\)/);
    expect(err.message).toContain('{broken json');
    expect(err.message).toContain('boom-on-stderr');
    await client.close();
  });

  it('0ba70e47 AC3b: settled requests leave no per-request exit listeners on the child', async () => {
    const child = spawnNode(
      `process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) {
         const m = JSON.parse(l); console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })); } });`
    );
    const client = new RpcClient(child);
    const baseline = child.listenerCount('exit');
    for (let i = 0; i < 25; i++) await client.request('ping', {}, 10_000);
    expect(child.listenerCount('exit')).toBe(baseline);
    await client.close();
  });
});
