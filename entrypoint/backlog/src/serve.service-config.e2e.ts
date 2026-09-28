/**
 * serve.service-config.e2e.ts — the D-A APPLY proof (the blocking review
 * finding this file closes): a `service.*` value supplied ONLY through the
 * environment must change what the REAL BUILT bin actually binds and mounts —
 * not merely what `resolveServiceConfig` returns.
 *
 * The defect: `createBacklogServer` consumed only `serviceConfig.server` and
 * `serviceConfig.readiness.timeoutMs`; the mount/listen path read raw `opts`
 * (so `ADHD_BACKLOG_SERVICE_PORT=4000 backlog serve` listened on 3300), and
 * `serve.ts`'s `parseArgs` always materialised `transport:'mcp'` as an
 * explicit opt — which the documented precedence (explicit opts > env >
 * layer files > default) lets OVERRIDE the resolved value, so
 * `ADHD_BACKLOG_SERVICE_TRANSPORT=http` mounted MCP.
 *
 * This test spawns the real built `dist/index.js` (never a bypass) with an
 * env-only port AND transport, no `--port`/`--transport` flags, then asserts
 * the ACTUALLY BOUND socket by issuing a real HTTP request to the env-only
 * port. It is deliberately an OBSERVABLE-OUTCOME assertion: if the transport
 * wiring regresses the process mounts MCP stdio and no HTTP listener exists;
 * if the port wiring regresses it binds 3300 and the request to the env port
 * fails. Either way the poll times out and the test goes RED.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  DIST_INDEX,
  mintBacklogSandbox,
  type SandboxHandle,
} from './test/helpers/spawn-backlog-bin.js';

/** A currently-free loopback TCP port, released before the spawn. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    srv.on('error', reject);
  });
}

/**
 * Bounded readiness poll (never a `sleep` for concurrency — this is the
 * accepted "has the process bound its port yet" pattern; AGENTS.md §7 rule 3
 * governs timing-based concurrency PROOFS, not a readiness deadline). Fails
 * loudly if the child exits before binding.
 */
async function waitForHttp(
  port: number,
  path: string,
  child: ChildProcess,
  stderr: () => string
): Promise<Response> {
  const deadline = Date.now() + 45_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `backlog serve exited early (code ${child.exitCode}) before binding ` +
          `127.0.0.1:${port}. stderr:\n${stderr()}`
      );
    }
    try {
      // Return the live response WITHOUT reading its body — the caller owns
      // `res.json()`; an eager `arrayBuffer()` here would consume it.
      return await fetch(`http://127.0.0.1:${port}${path}`);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(
    `backlog serve never answered on http://127.0.0.1:${port}${path} within ` +
      `the deadline: ${String(lastErr)}. stderr:\n${stderr()}`
  );
}

describe('backlog serve — the RESOLVED service.* config is APPLIED (env-only port + transport)', () => {
  let child: ChildProcess | undefined;
  let sandbox: SandboxHandle | undefined;
  let childStderr = '';

  afterEach(async () => {
    if (child) {
      const proc = child;
      child = undefined;
      if (proc.exitCode === null && proc.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve();
          }, 5000);
          timer.unref?.();
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          proc.kill('SIGTERM');
        });
      }
    }
    if (sandbox) rmSync(sandbox.adhdRoot, { recursive: true, force: true });
    sandbox = undefined;
    childStderr = '';
  });

  it('ADHD_BACKLOG_SERVICE_PORT + ADHD_BACKLOG_SERVICE_TRANSPORT (env only, no flags) make the built bin serve HTTP on that exact port', async () => {
    sandbox = mintBacklogSandbox();
    const port = await freePort();

    child = spawn(
      process.execPath,
      [DIST_INDEX, '--namespace', 'sandbox', 'serve'],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          ADHD_ROOT: sandbox.adhdRoot,
          ADHD_BACKLOG_SERVICE_PORT: String(port),
          ADHD_BACKLOG_SERVICE_TRANSPORT: 'http',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stderr?.on('data', (d: Buffer) => {
      childStderr += d.toString();
    });

    // A 200 from the OpenAPI meta route proves the fastify/HTTP transport is
    // mounted, and the request going to `port` proves the env-only port is
    // what the socket actually bound.
    const res = await waitForHttp(port, '/_meta/openapi', child, () => childStderr);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths?: Record<string, unknown> };
    expect(
      Object.keys(doc.paths ?? {}).some((p) => p.startsWith('/backlog/'))
    ).toBe(true);
  }, 60_000);
});
