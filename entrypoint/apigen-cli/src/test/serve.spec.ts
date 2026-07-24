import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  parseMounts,
  namespaceOfSource,
  namespaceFromUrl,
  httpNamespaceSegment,
  resolveHosts,
  aggregateHealth,
  findFreePort,
  startServe,
  type Host,
} from '../lib/commands/serve';
import { tokenize, type Operation, type Segment } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';

// ───────────────────────────────────────────────────────────────────────────
// apigen-serve-core py-grpc-serve-split: the gRPC front-proxy fixture below
// (`b.py`, namespace 'b') is addressed via the REAL
// `@adhd/apigen-engine-naming` `project(op).grpc` — the previous inline
// `namespace.capitalize()+"Service"`/raw-fn-name scheme this state deleted
// (see `grpc_server.py`'s module docstring) is gone, so a hand-typed address
// string here would silently drift from what the server actually serves.
// ───────────────────────────────────────────────────────────────────────────

/** Full `<package>.<Service>/<Method>` gRPC address for `fnName` in the
 * inline `b.py` fixture below (namespace 'b', file segment 'b'). */
function grpcAddrForB(fnName: string): string {
  const seg = (raw: string): Segment => ({ raw, words: tokenize(raw) });
  const op: Operation = {
    id: `b/b/${tokenize(fnName).join('-')}`,
    host: 'python',
    namespace: seg('b'),
    path: [seg('b'), seg(fnName)],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
  const g = project(op).grpc;
  return `${g.package}.${g.service}/${g.method}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — fast, deterministic, no spawning.
// ───────────────────────────────────────────────────────────────────────────

describe('[serve.parseMounts] --mount <ns>=<plugin> parsing', () => {
  it('parses ns=plugin pairs into a record', () => {
    expect(parseMounts(['a=api-fastify', 'b=py-flask'])).toEqual({
      a: 'api-fastify',
      b: 'py-flask',
    });
  });

  it('throws on a pair missing the = separator', () => {
    expect(() => parseMounts(['bad'])).toThrowError(/<namespace>=<plugin>/);
  });

  it('throws on an empty namespace or plugin side', () => {
    expect(() => parseMounts(['=plugin'])).toThrow();
    expect(() => parseMounts(['ns='])).toThrow();
  });
});

describe('[serve.namespaceOfSource] filename stem becomes the namespace', () => {
  it('strips directory and extension', () => {
    expect(namespaceOfSource('/x/y/users.ts')).toBe('users');
    expect(namespaceOfSource('billing.py')).toBe('billing');
    expect(namespaceOfSource('/a/b/api.mts')).toBe('api');
  });
});

describe('[serve.namespaceFromUrl] leading path segment routing', () => {
  it('extracts the namespace from the URL path', () => {
    expect(namespaceFromUrl('/users/getUser')).toBe('users');
    expect(namespaceFromUrl('/users/getUser?x=1')).toBe('users');
    expect(namespaceFromUrl('/_meta/health')).toBe('_meta');
    expect(namespaceFromUrl('/b/add_decimal')).toBe('b');
    expect(namespaceFromUrl('/')).toBe('');
  });
});

describe('[serve.httpNamespaceSegment] kebab-cased HTTP wire namespace (BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001)', () => {
  it('is a no-op for an already-kebab-neutral single word', () => {
    expect(httpNamespaceSegment('a')).toBe('a');
    expect(httpNamespaceSegment('billing')).toBe('billing');
  });

  it('tokenizes camelCase/PascalCase/snake_case into kebab-case', () => {
    expect(httpNamespaceSegment('myUserAccounts')).toBe('my-user-accounts');
    expect(httpNamespaceSegment('MyUserAccounts')).toBe('my-user-accounts');
    expect(httpNamespaceSegment('my_user_accounts')).toBe('my-user-accounts');
  });
});

describe('[serve.resolveHosts] partition by language → plugin', () => {
  it('routes .ts → api-fastify and .py → py-flask by default', () => {
    const hosts = resolveHosts(['/x/a.ts', '/x/b.py'], {});
    expect(
      hosts.map((h) => [h.namespace, h.language, h.plugin, h.transport])
    ).toEqual([
      ['a', 'ts', 'api-fastify', 'http'],
      ['b', 'py', 'py-flask', 'http'],
    ]);
  });

  it('honours a --mount override for a namespace', () => {
    const hosts = resolveHosts(['/x/a.ts'], { a: 'api-express' });
    expect(hosts[0]?.plugin).toBe('api-express');
    expect(hosts[0]?.transport).toBe('http');
  });

  it('sets transport=grpc for py-grpc plugin', () => {
    const hosts = resolveHosts(['/x/b.py'], { b: 'py-grpc' });
    expect(hosts[0]?.plugin).toBe('py-grpc');
    expect(hosts[0]?.transport).toBe('grpc');
  });

  it('throws on an unrecognised extension', () => {
    expect(() => resolveHosts(['/x/readme.md'], {})).toThrowError(
      /unrecognised extension/
    );
  });

  it('throws on duplicate namespaces (prefix collision)', () => {
    expect(() => resolveHosts(['/x/api.ts', '/y/api.py'], {})).toThrowError(
      /duplicate namespace/
    );
  });

  it('throws on a CANONICAL (kebab) collision even when the raw namespaces differ', () => {
    // 'myApi' and 'my-api' are different raw strings but both kebab to
    // 'my-api' — the same wire route prefix — so this must be caught here,
    // not silently shadow one host with another at request time.
    expect(() =>
      resolveHosts(['/x/myApi.ts', '/y/my-api.py'], {})
    ).toThrowError(/duplicate namespace "my-api".*collides with "myApi"/s);
  });
});

describe('[serve.aggregateHealth] merged per-host status (§13.1)', () => {
  const mk = (ns: string, alive: boolean, ready: boolean): Host => ({
    namespace: ns,
    language: 'ts',
    plugin: 'api-fastify',
    source: `/x/${ns}.ts`,
    port: 0,
    transport: 'http',
    alive,
    ready,
  });

  it('reports ok when every host is ready', () => {
    expect(aggregateHealth([mk('a', true, true), mk('b', true, true)])).toEqual(
      {
        status: 'ok',
        hosts: { a: 'ready', b: 'ready' },
      }
    );
  });

  it('reports degraded with the dead host down, others still ready (partial availability)', () => {
    expect(
      aggregateHealth([mk('a', true, true), mk('b', false, false)])
    ).toEqual({
      status: 'degraded',
      hosts: { a: 'ready', b: 'down' },
    });
  });

  it('a host that is alive but not yet ready is down', () => {
    expect(aggregateHealth([mk('a', true, false)])).toEqual({
      status: 'degraded',
      hosts: { a: 'down' },
    });
  });
});

describe('[serve.findFreePort] allocates distinct usable loopback ports', () => {
  it('returns a positive port number', async () => {
    const p = await findFreePort();
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(65536);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LIVE behavioural suite — drives the REAL serve stack: spawns real
// `apigen run` children (TS fastify + Python flask), proxies cross-language
// calls through the front, proves partial availability by killing the Python
// child, and proves orphan-free teardown.
//
// RUNS BY DEFAULT (no env flag): the serve front is the headline feature; a
// gated suite would let the real cross-language path rot unseen (the exact
// blind spot that hid BUG-009..013). The CLI bundle is guaranteed present via
// the `test` target's `dependsOn:["build"]`; `python3` is a hard prerequisite
// and a missing interpreter FAILS loudly rather than skipping. Only `grpcurl`
// (an optional external binary) degrades gracefully — its gRPC assertions
// self-skip with a warning when it is absent, never hiding a TS/Python failure.
//
// Determinism: every wait is a bounded poll of a real HTTP round-trip or a
// real process exit event — never a fixed sleep that races the system.
// ───────────────────────────────────────────────────────────────────────────

describe('[serve.live] real cross-language serve front', () => {
  let tmpDir: string | undefined;
  let shutdownFn: (() => Promise<void>) | undefined;

  afterEach(async () => {
    // Always tear the stack down so a failing assertion never leaks children.
    if (shutdownFn) {
      await shutdownFn();
      shutdownFn = undefined;
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  /**
   * The bundled standalone CLI — children are spawned as `node <bundle> run …`.
   * Build output is in-source ({projectRoot}/dist), so walk up from this test
   * file until `entrypoint/apigen-cli/dist/index.js` exists, robust to how
   * vitest sets `__dirname`/`--root`.
   */
  const cliPath = (() => {
    let dir = __dirname;
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, 'entrypoint/apigen-cli/dist/index.js');
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    return path.resolve(__dirname, '../../dist/index.js');
  })();

  /** Bounded poll of an HTTP endpoint until `predicate(status)` holds. */
  async function pollUntil(
    fn: () => Promise<Response>,
    predicate: (status: number) => boolean,
    timeoutMs = 10000
  ): Promise<Response> {
    const deadline = Date.now() + timeoutMs;
    let last: Response | undefined;
    while (Date.now() < deadline) {
      try {
        last = await fn();
        if (predicate(last.status)) return last;
      } catch {
        /* connection refused while child restarts — keep polling */
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    throw new Error(
      `pollUntil exceeded ${timeoutMs}ms (last status ${last?.status})`
    );
  }

  it(
    'proxies TS + Python calls, isolates a dead host to 503, and leaves zero orphans',
    { timeout: 60000 },
    async () => {
      // The built CLI bundle must exist (run `nx build apigen-cli` first).
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath}`).toBe(
        true
      );

      // --- fixtures: one TS source, one Python Decimal source, and a
      // multi-word-namespace TS source (proves BUG-APIGEN-CLI-SERVE-FRONT-
      // PROXY-DOUBLE-SEGMENT-001's kebab-namespace fix, not just the
      // already-kebab-neutral single-letter `a`/`b` fixtures) ---
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-serve-'));
      const aTs = path.join(tmpDir, 'a.ts');
      const bPy = path.join(tmpDir, 'b.py');
      const myUserAccountsTs = path.join(tmpDir, 'myUserAccounts.ts');
      fs.writeFileSync(
        aTs,
        `export async function addNumbers(a: number, b: number): Promise<number> { return a + b }\n` +
          `export async function greet(name: string): Promise<string> { return \`hello, \${name}\` }\n`
      );
      fs.writeFileSync(
        bPy,
        `from decimal import Decimal\n\n` +
          `def add_decimal(amount: Decimal) -> Decimal:\n` +
          `    return amount + Decimal("0.001")\n`
      );
      fs.writeFileSync(
        myUserAccountsTs,
        `export async function listAll(): Promise<string[]> { return ['x'] }\n`
      );

      const port = await findFreePort();
      const { hosts, shutdown } = await startServe({
        sources: [aTs, bPy, myUserAccountsTs],
        port,
        cliPath,
        log: () => undefined,
      });
      shutdownFn = shutdown;
      const base = `http://127.0.0.1:${port}`;

      // --- all hosts ready ---
      const health0 = (await (await fetch(`${base}/_meta/health`)).json()) as {
        status: string;
        hosts: Record<string, string>;
      };
      expect(health0).toEqual({
        status: 'ok',
        hosts: { a: 'ready', b: 'ready', myUserAccounts: 'ready' },
      });

      // --- TS call through the front (in-process TS host) ---
      // Canonical route (BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001):
      // `/<ns>/<file-stem>/<op>`, every segment kebab-cased — byte-identical
      // to `@adhd/apigen-engine-naming`'s `project(op).http.route`, verified against
      // the real spawned api-fastify child, NOT a flat `/a/addNumbers`.
      // FEAT-APIGEN-022: addNumbers(a: number, b: number) — all-primitive
      // params — auto-hoists to GET (query-string), not POST.
      const tsRes = await fetch(`${base}/a/a/add-numbers?a=2&b=40`, {
        method: 'GET',
      });
      expect(tsRes.status).toBe(200);
      expect(await tsRes.json()).toBe(42);

      // The pre-fix flat 2-segment shape must NOT resolve — proves the front
      // isn't accidentally tolerant of the old shape via some other path.
      const tsFlat = await fetch(`${base}/a/addNumbers?a=2&b=40`, {
        method: 'GET',
      });
      expect(tsFlat.status).toBe(404);

      // --- Python Decimal call through the proxy: exact decimal string ---
      // Canonical route: `/b/b/add-decimal` (namespace "b" + file-stem "b" +
      // kebab("add_decimal")), verified against the real spawned py-flask child.
      const pyRes = await fetch(`${base}/b/b/add-decimal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { amount: '123.456' } }),
      });
      expect(pyRes.status).toBe(200);
      expect(await pyRes.json()).toBe('123.457');

      // --- multi-word namespace host: canonical kebab route resolves ---
      // `myUserAccounts` (raw) → `my-user-accounts` (wire) at EVERY segment.
      // This is the case the raw-namespace-keyed routing table before the fix
      // could never serve (`byNamespace` was keyed by the raw `myUserAccounts`
      // string, which never appears on the wire — the real child only ever
      // answers at the kebab form).
      const multiWordRes = await fetch(
        `${base}/my-user-accounts/my-user-accounts/list-all`
      );
      expect(multiWordRes.status).toBe(200);
      expect(await multiWordRes.json()).toEqual(['x']);

      // The raw (un-kebabed) namespace must NOT resolve — a regression back
      // to keying `byNamespaceHttp` by the raw string would make this 200.
      const multiWordRaw = await fetch(
        `${base}/myUserAccounts/myUserAccounts/listAll`
      );
      expect(multiWordRaw.status).toBe(404);

      // --- partial availability: kill the Python child, /b/* → 503, /a/* → 200 ---
      const pyHost = hosts.find((h) => h.namespace === 'b');
      expect(pyHost?.child?.pid).toBeDefined();
      pyHost?.child?.kill('SIGKILL');

      // Bounded wait until the front observes the death (exit event flips alive).
      const downRes = await pollUntil(
        () =>
          fetch(`${base}/b/b/add-decimal`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: { amount: '1.0' } }),
          }),
        (s) => s === 503
      );
      expect(downRes.status).toBe(503);
      const downBody = (await downRes.json()) as {
        details?: { gatewayCode?: string; host?: string };
      };
      expect(downBody.details?.gatewayCode).toBe('unavailable');
      expect(downBody.details?.host).toBe('b');

      // The TS host keeps serving — a dead host fails ONLY its own ops.
      // FEAT-APIGEN-022: all-primitive params — GET, not POST.
      const stillUp = await fetch(`${base}/a/a/add-numbers?a=1&b=1`, {
        method: 'GET',
      });
      expect(stillUp.status).toBe(200);
      expect(await stillUp.json()).toBe(2);

      // Aggregate health now degraded with b down, others still ready.
      const health1 = (await (await fetch(`${base}/_meta/health`)).json()) as {
        status: string;
        hosts: Record<string, string>;
      };
      expect(health1).toEqual({
        status: 'degraded',
        hosts: { a: 'ready', b: 'down', myUserAccounts: 'ready' },
      });

      // --- orphan-free teardown: shutdown kills the remaining TS child ---
      const tsHost = hosts.find((h) => h.namespace === 'a');
      const tsPid = tsHost?.child?.pid;
      expect(tsPid).toBeDefined();

      await shutdown();
      shutdownFn = undefined;

      // Prove the surviving child actually exited (no orphan).  A live process
      // answers `kill(pid, 0)`; a reaped one throws ESRCH.  Bounded poll.
      const exited = await (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try {
            process.kill(tsPid as number, 0);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
          }
          await new Promise<void>((r) => setTimeout(r, 100));
        }
        return false;
      })();
      expect(
        exited,
        `TS child pid ${tsPid} should be gone after shutdown`
      ).toBe(true);
      expect(tsHost?.alive).toBe(false);
    }
  );

  it(
    'mounts a gRPC host (py-grpc) on the same front port as HTTP hosts',
    { timeout: 60000 },
    async () => {
      // The built CLI bundle must exist (run `nx build apigen-cli` first).
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath}`).toBe(
        true
      );

      // Locate grpcurl — required for this test.
      const grpcurlPath = (() => {
        const candidates = [
          '/opt/homebrew/bin/grpcurl',
          '/usr/local/bin/grpcurl',
          '/usr/bin/grpcurl',
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) return c;
        }
        return null;
      })();
      if (!grpcurlPath) {
        console.warn(
          '[serve.grpc.live] grpcurl not found — skipping gRPC assertions'
        );
      }

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-grpc-serve-'));
      const aTs = path.join(tmpDir, 'a.ts');
      const bPy = path.join(tmpDir, 'b.py');
      fs.writeFileSync(
        aTs,
        `export async function addNumbers(a: number, b: number): Promise<number> { return a + b }\n`
      );
      fs.writeFileSync(
        bPy,
        `from decimal import Decimal\n\n` +
          `def add_decimal(amount: Decimal) -> Decimal:\n` +
          `    return amount + Decimal("0.001")\n\n` +
          `def greet(name: str) -> str:\n` +
          `    return f"Hello, {name}!"\n`
      );

      const port = await findFreePort();
      const { hosts, shutdown } = await startServe({
        sources: [aTs, bPy],
        port,
        mounts: { b: 'py-grpc' },
        cliPath,
        log: () => undefined,
      });
      shutdownFn = shutdown;
      const base = `http://127.0.0.1:${port}`;

      // Verify transport tags.
      const tsHost = hosts.find((h) => h.namespace === 'a');
      const grpcHost = hosts.find((h) => h.namespace === 'b');
      expect(tsHost?.transport).toBe('http');
      expect(grpcHost?.transport).toBe('grpc');

      // --- aggregate health: both hosts ready ---
      const health0 = (await (await fetch(`${base}/_meta/health`)).json()) as {
        status: string;
        hosts: Record<string, string>;
      };
      expect(health0).toEqual({
        status: 'ok',
        hosts: { a: 'ready', b: 'ready' },
      });

      // --- TS host serves HTTP on the same port ---
      // Canonical route (BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001):
      // `/a/a/add-numbers`, not the flat pre-fix `/a/addNumbers`.
      // FEAT-APIGEN-022: all-primitive params — GET, not POST.
      const tsRes = await fetch(`${base}/a/a/add-numbers?a=2&b=40`, {
        method: 'GET',
      });
      expect(tsRes.status).toBe(200);
      expect(await tsRes.json()).toBe(42);

      // --- gRPC host: call via grpcurl routed through the front port ---
      if (grpcurlPath) {
        const { spawn } = await import('node:child_process');

        /**
         * Run grpcurl asynchronously so the Node.js event loop remains free
         * to process the in-process h2 server's requests.
         * `spawnSync` would block the event loop, preventing the proxy from
         * forwarding packets while grpcurl waits — causing a 10 s timeout.
         */
        const grpcurl = grpcurlPath;
        const runGrpcurl = (
          args: string[],
          timeoutMs = 10000
        ): Promise<{
          status: number | null;
          stdout: string;
          stderr: string;
        }> =>
          new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            const child = spawn(grpcurl, args, {
              encoding: 'utf8',
            } as never);
            child.stdout.on('data', (d: Buffer) => {
              stdout += d.toString();
            });
            child.stderr.on('data', (d: Buffer) => {
              stderr += d.toString();
            });
            const timer = setTimeout(() => {
              child.kill();
              resolve({ status: null, stdout, stderr });
            }, timeoutMs);
            child.once('exit', (code) => {
              clearTimeout(timer);
              resolve({ status: code, stdout, stderr });
            });
          });

        // gRPC call through the front (HTTP/2 h2c, detected by PRI preface)
        const grpcResult = await runGrpcurl([
          '-plaintext',
          '-d',
          JSON.stringify({ data: { amount: '123.456' } }),
          `127.0.0.1:${port}`,
          grpcAddrForB('add_decimal'),
        ]);
        // grpc-status 0 = OK
        expect(
          grpcResult.status,
          `grpcurl exit; stderr=${grpcResult.stderr?.slice(0, 300)}`
        ).toBe(0);
        const grpcBody = JSON.parse(grpcResult.stdout) as { data: string };
        const grpcResult2 = JSON.parse(grpcBody.data) as string;
        expect(grpcResult2, 'Decimal round-trip through gRPC front').toBe(
          '123.457'
        );

        // --- gRPC plain string call ---
        const greetResult = await runGrpcurl([
          '-plaintext',
          '-d',
          JSON.stringify({ data: { name: 'FrontProxy' } }),
          `127.0.0.1:${port}`,
          grpcAddrForB('greet'),
        ]);
        expect(
          greetResult.status,
          `grpcurl greet exit; stderr=${greetResult.stderr?.slice(0, 200)}`
        ).toBe(0);
        const greetBody = JSON.parse(greetResult.stdout) as { data: string };
        expect(JSON.parse(greetBody.data)).toBe('Hello, FrontProxy!');

        // --- kill gRPC host → gRPC calls return UNAVAILABLE (status 14), TS still works ---
        expect(grpcHost?.child?.pid).toBeDefined();
        grpcHost?.child?.kill('SIGKILL');

        // Bounded wait until alive flips false.
        const grpcDown = await (async () => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (grpcHost && !grpcHost.alive) return true;
            await new Promise<void>((r) => setTimeout(r, 100));
          }
          return false;
        })();
        expect(grpcDown, 'gRPC host should be dead').toBe(true);

        // gRPC call to dead host → UNAVAILABLE (grpcurl exits non-zero).
        const deadResult = await runGrpcurl(
          [
            '-plaintext',
            '-d',
            JSON.stringify({ data: { amount: '1.0' } }),
            `127.0.0.1:${port}`,
            grpcAddrForB('add_decimal'),
          ],
          5000
        );
        // Exit non-zero because the server returned a gRPC error status.
        expect(
          deadResult.status !== 0 ||
            deadResult.stderr.includes('Unavailable') ||
            deadResult.stderr.includes('unavailable') ||
            deadResult.stderr.includes('UNAVAILABLE'),
          `Expected gRPC error after host death; stderr=${deadResult.stderr?.slice(
            0,
            300
          )} exit=${deadResult.status}`
        ).toBe(true);
      }

      // TS still serves even after gRPC child death.
      // FEAT-APIGEN-022: all-primitive params — GET, not POST.
      const stillUp = await fetch(`${base}/a/a/add-numbers?a=1&b=1`, {
        method: 'GET',
      });
      expect(stillUp.status).toBe(200);
      expect(await stillUp.json()).toBe(2);

      // Aggregate health degraded: b down, a still ready.
      const healthDeg = (await (
        await fetch(`${base}/_meta/health`)
      ).json()) as {
        status: string;
        hosts: Record<string, string>;
      };
      expect(healthDeg.status).toBe('degraded');
      expect(healthDeg.hosts['a']).toBe('ready');
      expect(healthDeg.hosts['b']).toBe('down');

      await shutdown();
      shutdownFn = undefined;
    }
  );

  it(
    'cleans up children on SIGTERM and leaves zero orphan processes',
    { timeout: 30000 },
    async () => {
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath}`).toBe(
        true
      );

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-sigterm-'));
      const aTs = path.join(tmpDir, 'a.ts');
      fs.writeFileSync(
        aTs,
        `export async function addNumbers(a: number, b: number): Promise<number> { return a + b }\n`
      );

      const port = await findFreePort();

      const serveProc: ChildProcess = spawn(
        process.execPath,
        [cliPath, 'serve', '--source', aTs, '--port', String(port)],
        { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
      );

      // Guarantee cleanup: if anything goes wrong, kill the spawned process.
      const cleanupProc = () => {
        try {
          serveProc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      };

      try {
        // Wait for the front to be healthy.
        const deadline = Date.now() + 15000;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/_meta/health`);
            if (res.status === 200) {
              ready = true;
              break;
            }
          } catch {
            /* connection refused — keep polling */
          }
          await new Promise<void>((r) => setTimeout(r, 200));
        }
        expect(
          ready,
          `serve did not become ready on port ${port} within 15 s`
        ).toBe(true);

        // Send SIGTERM to the serve process.
        serveProc.kill('SIGTERM');

        // Wait for the process to exit.
        const exitCode = await new Promise<number | null>((resolve) => {
          serveProc.once('exit', (code) => resolve(code));
        });
        // SIGTERM → clean exit (code 0 from process.exit(0) in onSignal).
        expect(exitCode).toBe(0);

        // Give the OS a moment to release the port.
        await new Promise<void>((r) => setTimeout(r, 500));

        // Verify the front port is free — no orphan server is still listening.
        const portFree = await new Promise<boolean>((resolve) => {
          const srv = net.createServer();
          srv.once('error', () => resolve(false));
          srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
          });
        });
        expect(portFree, `port ${port} should be free after serve shutdown`).toBe(
          true
        );
      } finally {
        cleanupProc();
      }
    }
  );
});
