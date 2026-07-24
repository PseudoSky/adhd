/**
 * [mcp-adapter.10] dod.15 — SSE-client + StreamableHTTP-client transport
 * parity spec.
 *
 * Drives BOTH mcp HTTP transports (`sse` and `streaming-http`) through REAL
 * `@modelcontextprotocol/sdk` client transports (`SSEClientTransport` /
 * `StreamableHTTPClientTransport`) against real `run()`-started servers —
 * never plugin internals (AGENTS.md "Proving an MCP server works").
 *
 * Covers, for each transport:
 *   - handshake:  `client.connect()` succeeds and `tools/list` returns the
 *     expected tool.
 *   - session routing: TWO independent client sessions against the SAME
 *     server BOTH work. For `sse` this is the literal MCP SDK session
 *     concept (`SSEServerTransport.sessionId`, POSTs routed by `sessionId`)
 *     — and is the regression surface for the negative control below (see
 *     module doc's "discovered-in-passing" note in `run.ts`: pre-migration,
 *     `sse` reused a SINGLE shared `Server` across every session, and the
 *     MCP SDK's `Protocol.connect()` throws "Already connected to a
 *     transport" for a second concurrent connection). For `streaming-http`
 *     (stateless — no session concept), the equivalent proof is that two
 *     independent, concurrent client connections both complete correctly
 *     with no cross-request state leakage.
 *   - graceful-error-no-teardown (dod.15): a tool call that ERRORS (a real
 *     domain `ApiError`) is immediately followed by a SECOND, unrelated
 *     `callTool` on the SAME client/server — the second call must still
 *     succeed. Proves one erroring request doesn't tear down the
 *     session/server for subsequent requests.
 *   - abort/shutdown: aborting `RunInput.signal` resolves the `run()`
 *     promise and stops the server from accepting further connections.
 *
 * Negative control ([inv:negative-control]): reuses
 * `docs/plan/apigen-serve-core/neg-control/mcp-adapter.patch`'s SECOND hunk
 * (documented in that file), which reverts the `sse` per-session
 * `createMcpServer()` fix back to a single shared `Server` instance —
 * BREAKING THE HANDSHAKE for the second of two concurrent SSE sessions
 * (`Protocol.connect()`'s "Already connected to a transport" throw). Proven
 * RED then GREEN via a fresh child-process `vitest` invocation per check —
 * see `run.spec.ts`'s "[mcp-adapter.6] negative control" module doc for why
 * a source-level patch cannot be observed against an already-imported,
 * already-running server in this same test process.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { run } from '../lib/run';
import type { RunInput } from '@adhd/apigen-core-client';
import { ApiError } from '@adhd/apigen-base-errors';
import { proveNegativeControl } from '@adhd/apigen-engine-runtime/test-support';

/** Bind a TCP server to port 0, record the OS-assigned port, close it, return that port. */
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
 * Both `transport-http-parity.spec.ts` and `run.spec.ts` apply the SAME
 * `neg-control/mcp-adapter.patch` (two hunks, one file). Vitest runs
 * separate test FILES concurrently by default, so without serialization two
 * `proveNegativeControl` calls racing `git apply`/`git apply -R` against the
 * same patch can collide. Cross-process advisory lock (atomic `mkdir`),
 * mirrored from `run.spec.ts`'s own copy (kept local — these are two
 * independent spec files, never importing one another to avoid
 * double-registering the other file's tests).
 */
async function withNegControlLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(repoRoot, 'tmp', 'apigen-plugin-mcp', 'neg-control-run-ts.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`withNegControlLock: timed out waiting for lock at ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Walk up from `startDir` to the nearest ancestor containing `.git` (the repo root). */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`findRepoRoot: no ".git" found walking up from ${startDir}`);
    }
    dir = parent;
  }
}

// ---------- fixtures ----------

function parityGetUser(userId: string): { id: string; name: string } {
  return { id: userId, name: `User-${userId}` };
}
function parityGetThing(id: string): { id: string } {
  if (id === 'missing') throw new ApiError('not_found', 'no such thing');
  return { id };
}

const httpParitySchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
  getThing: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
};

async function startServer(
  transport: 'sse' | 'streaming-http'
): Promise<{ port: number; controller: AbortController; done: Promise<void> }> {
  const port = await freePort();
  const controller = new AbortController();
  const runInput: RunInput = {
    packages: [
      {
        id: 'http-parity-pkg',
        schemas: httpParitySchema,
        importPath: '@test/http-parity-pkg',
        fns: {
          getUser: (userId: unknown) => parityGetUser(userId as string),
          getThing: (id: unknown) => parityGetThing(id as string),
        },
      },
    ],
    outputDir: '/tmp/out',
    options: { transport, port },
    signal: controller.signal,
  };
  const done = run(runInput);
  done.catch(() => {
    /* swallowed after abort */
  });
  return { port, controller, done };
}

async function connectSse(port: number): Promise<Client> {
  const client = new Client({ name: 'mcp-adapter-http-parity-sse', version: '1.0.0' });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)));
      return client;
    } catch {
      if (Date.now() > deadline) throw new Error('sse server did not become ready in 10s');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function connectStreamingHttp(port: number): Promise<Client> {
  const client = new Client({
    name: 'mcp-adapter-http-parity-streaming-http',
    version: '1.0.0',
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      );
      return client;
    } catch {
      if (Date.now() > deadline) throw new Error('streaming-http server did not become ready in 10s');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// ---------------------------------------------------------------------------
// sse
// ---------------------------------------------------------------------------

describe('[mcp-adapter.10] sse transport — real SSEClientTransport parity', () => {
  let port: number;
  let controller: AbortController;
  let done: Promise<void>;

  beforeAll(async () => {
    ({ port, controller, done } = await startServer('sse'));
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  it('handshake: connects and lists the expected tool', async () => {
    const client = await connectSse(port);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('http_parity_pkg_http_parity_pkg_get_user');
    } finally {
      await client.close();
    }
  });

  it('session routing: TWO independent SSE sessions against the SAME server BOTH work', async () => {
    const clientA = await connectSse(port);
    const clientB = await connectSse(port);
    try {
      const [resA, resB] = await Promise.all([
        clientA.callTool({
          name: 'http_parity_pkg_http_parity_pkg_get_user',
          arguments: { data: { userId: 'session-a' } },
        }),
        clientB.callTool({
          name: 'http_parity_pkg_http_parity_pkg_get_user',
          arguments: { data: { userId: 'session-b' } },
        }),
      ]);
      const contentA = resA.content as Array<{ type: string; text: string }>;
      const contentB = resB.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(contentA[0].text)).toEqual(parityGetUser('session-a'));
      expect(JSON.parse(contentB[0].text)).toEqual(parityGetUser('session-b'));
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });

  it('dod.15 graceful-error-no-teardown: an erroring call is followed by a successful call on the SAME session', async () => {
    const client = await connectSse(port);
    try {
      await expect(
        client.callTool({
          name: 'http_parity_pkg_http_parity_pkg_get_thing',
          arguments: { data: { id: 'missing' } },
        })
      ).rejects.toThrow();

      const result = await client.callTool({
        name: 'http_parity_pkg_http_parity_pkg_get_user',
        arguments: { data: { userId: 'still-alive' } },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(parityGetUser('still-alive'));
    } finally {
      await client.close();
    }
  });

  it('abort/shutdown: aborting the signal resolves run() and the server stops accepting connections', async () => {
    controller.abort();
    await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('server did not close within 2s')), 2000)
      ),
    ]);
    await expect(
      fetch(`http://127.0.0.1:${port}/sse`).then((r) => r.text())
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// streaming-http
// ---------------------------------------------------------------------------

describe('[mcp-adapter.10] streaming-http transport — real StreamableHTTPClientTransport parity', () => {
  let port: number;
  let controller: AbortController;
  let done: Promise<void>;

  beforeAll(async () => {
    ({ port, controller, done } = await startServer('streaming-http'));
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  it('handshake: connects and lists the expected tool', async () => {
    const client = await connectStreamingHttp(port);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('http_parity_pkg_http_parity_pkg_get_user');
    } finally {
      await client.close();
    }
  });

  it('session routing: TWO independent concurrent connections against the SAME server BOTH work (no cross-request state leakage)', async () => {
    const clientA = await connectStreamingHttp(port);
    const clientB = await connectStreamingHttp(port);
    try {
      const [resA, resB] = await Promise.all([
        clientA.callTool({
          name: 'http_parity_pkg_http_parity_pkg_get_user',
          arguments: { data: { userId: 'conn-a' } },
        }),
        clientB.callTool({
          name: 'http_parity_pkg_http_parity_pkg_get_user',
          arguments: { data: { userId: 'conn-b' } },
        }),
      ]);
      const contentA = resA.content as Array<{ type: string; text: string }>;
      const contentB = resB.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(contentA[0].text)).toEqual(parityGetUser('conn-a'));
      expect(JSON.parse(contentB[0].text)).toEqual(parityGetUser('conn-b'));
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });

  it('dod.15 graceful-error-no-teardown: an erroring call is followed by a successful call on the SAME server', async () => {
    const client = await connectStreamingHttp(port);
    try {
      await expect(
        client.callTool({
          name: 'http_parity_pkg_http_parity_pkg_get_thing',
          arguments: { data: { id: 'missing' } },
        })
      ).rejects.toThrow();

      const result = await client.callTool({
        name: 'http_parity_pkg_http_parity_pkg_get_user',
        arguments: { data: { userId: 'still-alive' } },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(parityGetUser('still-alive'));
    } finally {
      await client.close();
    }
  });

  it('abort/shutdown: aborting the signal resolves run() and the server stops accepting connections', async () => {
    controller.abort();
    await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('server did not close within 2s')), 2000)
      ),
    ]);
    await expect(
      fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }).then((r) => r.text())
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [inv:negative-control] — breaks the handshake for a SECOND concurrent SSE
// session (see module doc). Reuses mcp-adapter.patch's SECOND hunk.
// ---------------------------------------------------------------------------

describe('[mcp-adapter.10] negative control — sse session routing actually gates', () => {
  it(
    'reverting the per-session Server fix (mcp-adapter.patch hunk 2) breaks the SECOND SSE session\'s handshake; reverting the patch fixes it',
    async () => {
      const repoRoot = findRepoRoot(__dirname);
      const patchPath = path.join(
        repoRoot,
        'docs/plan/apigen-serve-core/neg-control/mcp-adapter.patch'
      );

      function runSessionRoutingCheckInFreshProcess(): void {
        const result = spawnSync(
          process.execPath,
          [
            path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--config',
            path.join(repoRoot, 'packages/apigen/apigen-plugin-mcp/vite.config.ts'),
            '-t',
            'session routing: TWO independent SSE sessions against the SAME server BOTH work',
          ],
          { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }
        );
        if (result.status !== 0) {
          throw new Error(
            `sse session-routing check failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
          );
        }
      }

      await withNegControlLock(repoRoot, () =>
        proveNegativeControl(runSessionRoutingCheckInFreshProcess, patchPath, {
          cwd: repoRoot,
        })
      );
    },
    60000
  );
});
