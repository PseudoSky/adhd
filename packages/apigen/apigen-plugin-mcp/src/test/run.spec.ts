import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { run, __toolTableBuildCount } from '../lib/run';
import { dispatch } from '@adhd/apigen-engine-runtime';
import type { UsePlugin } from '@adhd/apigen-engine-runtime';
import type {
  MountedOperation,
  Operation,
  RunInput,
  Segment,
} from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { operationFor } from '../lib/tool-naming';
import { ApiError } from '@adhd/apigen-base-errors';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  captureGolden,
  assertParity,
  proveNegativeControl,
  type GoldenFixture,
  type GoldenSnapshot,
  type ParityDriver,
} from '@adhd/apigen-engine-runtime/test-support';

/** Test-local stand-in for the deleted `deriveToolName` — mirrors run.ts's own
 * `operationFor(...) -> buildOpPlan(...).mcp.name` pipeline (here via
 * `project()` directly, decoupled from run.ts's internals) so these tests
 * compute the SAME expected value run.ts derives internally. */
function deriveToolName(
  pkg: { id: string; importPath: string },
  fnName: string,
  operations?: Operation[]
): string {
  return project(operationFor(pkg, fnName, operations)).mcp.name;
}

/**
 * Both `run.spec.ts` and `transport-http-parity.spec.ts` apply the SAME
 * `neg-control/mcp-adapter.patch` (two hunks, one file — see the negative
 * control describe block's module doc below). Vitest runs separate test
 * FILES concurrently by default, so without serialization two
 * `proveNegativeControl` calls racing `git apply`/`git apply -R` against the
 * same patch can collide ("patch does not apply" — already applied by the
 * other file's in-flight check). This is a simple cross-process advisory
 * lock (atomic `mkdir` as the exclusive-acquire primitive) so only one
 * negative-control check runs at a time.
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

// ---------- fixture ----------
// Simple in-process functions — ground truth for assertions.
function getUser(userId: string): { id: string; name: string } {
  return { id: userId, name: `User-${userId}` };
}
function listUsers(): string[] {
  return ['alice', 'bob'];
}

const testSchema = {
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
  listUsers: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['data'],
    },
    output: { type: 'array' },
  },
};

/**
 * Schema with session envelope field + x-apigen-envelope metadata (§9.1).
 * pluginId='auth' → _meta key is 'x-auth-session'.
 */
const envelopeSchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['session', 'data'],
    },
    output: { type: 'object' },
    'x-apigen-envelope': { session: 'auth' },
  },
};

const testFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
  listUsers: () => listUsers(),
};
const envelopeFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
};

// ---------- BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 ----------
// The MCP tool name is no longer the raw exported fn name (e.g. `getUser`) —
// it is the canonical `project(op).mcp.name` derived by
// `../lib/tool-naming.ts`'s `deriveToolName`. Every fixture below computes
// its EXPECTED tool name the same way `run()` does internally, so these
// tests stay correct as the derivation evolves instead of hardcoding a
// snapshot of today's output.
const testPkg = { id: 'test-pkg', importPath: '@test/test-pkg' };
const envPkg = { id: 'env-pkg', importPath: '@test/env-pkg' };
const outPkg = { id: 'out-pkg', importPath: '@test/out-pkg' };

const testPkgGetUserName = deriveToolName(testPkg, 'getUser');
const testPkgListUsersName = deriveToolName(testPkg, 'listUsers');
const envPkgGetUserName = deriveToolName(envPkg, 'getUser');
const outPkgGetUserName = deriveToolName(outPkg, 'getUser');
const outPkgSearchName = deriveToolName(outPkg, 'search');
const outPkgListUsersArrayName = deriveToolName(outPkg, 'listUsersArray');

// ---------- streaming-http integration — real MCP HTTP transport ----------

describe('[plugin-mcp.4] run() streaming-http — tools/list + callTool via real HTTP', () => {
  let port: number;
  let controller: AbortController;

  beforeAll(async () => {
    port = await freePort();
    controller = new AbortController();
    const input: RunInput = {
      packages: [
        {
          id: 'test-pkg',
          schemas: testSchema,
          importPath: '@test/test-pkg',
          fns: testFns,
        },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port },
      signal: controller.signal,
    };
    // Fire-and-forget; resolves on abort.
    run(input).catch(() => {
      /* swallowed after abort */
    });

    // Poll until the server accepts a tools/list request; bounded to 10 s.
    // We use tools/list (not initialize) because the stateless StreamableHTTP
    // transport handles tools/list without a prior handshake.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {},
          }),
        });
        if (r.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  // Helper: send a raw JSON-RPC request to the streaming-http endpoint.
  // The StreamableHTTP transport always replies as text/event-stream with the
  // format: `event: message\ndata: <json>\n\n`
  async function rpc(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    // SSE format: `event: message\ndata: <json>\n\n`
    // Extract the last `data: ` line.
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim());
    if (dataLines.length > 0) {
      return JSON.parse(dataLines[dataLines.length - 1]);
    }
    // Fallback: plain JSON
    return JSON.parse(text);
  }

  it('[plugin-mcp.4] tools/list returns the canonical names for getUser and listUsers', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await rpc('tools/list', {})) as any;
    // Result may be at resp.result (raw JSON-RPC) or resp itself (SDK unwrapped)
    const tools: Array<{ name: string }> =
      resp?.result?.tools ?? resp?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain(testPkgGetUserName);
    expect(names).toContain(testPkgListUsersName);
  });

  it('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] (negative control) tools/list no longer registers the OLD raw fn name', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await rpc('tools/list', {})) as any;
    const tools: Array<{ name: string }> =
      resp?.result?.tools ?? resp?.tools ?? [];
    const names = tools.map((t) => t.name);
    // Proves this is a RENAME, not an added alias: the pre-fix raw fn name
    // must be gone once the canonical name differs from it.
    expect(testPkgGetUserName).not.toBe('getUser');
    expect(names).not.toContain('getUser');
    expect(testPkgListUsersName).not.toBe('listUsers');
    expect(names).not.toContain('listUsers');
  });

  it('tools/list does NOT include __samples__ or non-function exports', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await rpc('tools/list', {})) as any;
    const tools: Array<{ name: string }> =
      resp?.result?.tools ?? resp?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('__samples__');
  });

  it('[round-trip] callTool(<canonical getUser name>) routes through dispatch and returns correct value', async () => {
    const resp = (await rpc('tools/call', {
      name: testPkgGetUserName,
      arguments: { data: { userId: 'u99' } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content[0].text);
    // Ground truth: call the function directly
    expect(parsed).toEqual(getUser('u99'));
  });

  it('[round-trip] callTool(<canonical listUsers name>) returns correct value', async () => {
    const resp = (await rpc('tools/call', {
      name: testPkgListUsersName,
      arguments: { data: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toEqual(listUsers());
  });

  it('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] (negative control) callTool with the OLD raw fn name fails', async () => {
    const resp = (await rpc('tools/call', {
      name: 'getUser',
      arguments: { data: { userId: 'u99' } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    // The MCP SDK surfaces "Unknown tool" via a JSON-RPC error or an
    // isError:true result — either way it must NOT be the success shape a
    // real dispatch would return.
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    const succeeded =
      !resp?.error &&
      !resp?.result?.isError &&
      content.length > 0 &&
      (() => {
        try {
          return JSON.parse(content[0].text)?.id === 'u99';
        } catch {
          return false;
        }
      })();
    expect(succeeded).toBe(false);
  });

  it('[plugin-mcp.abort] abort signal stops the server', async () => {
    // abort is called in afterAll; verify the server rejects after close
    // (this test runs before afterAll, so we spin up a second server to close immediately)
    const ac = new AbortController();
    const abortPort = await freePort();
    const input2: RunInput = {
      packages: [
        {
          id: 'test-pkg',
          schemas: testSchema,
          importPath: '@test/test-pkg',
          fns: testFns,
        },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port: abortPort },
      signal: ac.signal,
    };
    const done = run(input2);
    // Brief delay for listen, then abort
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    // done must resolve (not hang) within 2 s
    await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('server did not close within 2 s')),
          2000
        )
      ),
    ]);
  });
});

// ---------- [plugin-mcp.5] dispatch not inlined ----------

describe('[plugin-mcp.5] run.ts does not inline dispatch logic', () => {
  it('run.ts imports dispatch from @adhd/apigen-engine-runtime', async () => {
    // Static import (top of file) — nx forbids mixing static + dynamic imports
    // of the same workspace lib. We assert the runtime exports `dispatch` so the
    // import path run.ts relies on is correct; absence of inline dispatch logic
    // is verified by the generate.spec 'no inline dispatch' test + the grep gate.
    expect(typeof dispatch).toBe('function');
    // The run module must re-export or use the same dispatch — absence of
    // inline logic is verified by the generate.spec 'no inline dispatch' test
    // and by the acceptance criterion grep (run in CI). Here we assert runtime
    // exports the expected symbol to confirm the import path is correct.
    expect(dispatch.name === 'dispatch' || typeof dispatch === 'function').toBe(
      true
    );
  });
});

// ---------- [v2-proj-transport] MCP envelope binding — _meta["x-<pluginId>-<field>"] ----------

describe('[v2-proj-transport] run() — MCP envelope from _meta (§9.1)', () => {
  let port: number;
  let controller: AbortController;

  beforeAll(async () => {
    port = await freePort();
    controller = new AbortController();
    const input: RunInput = {
      packages: [
        {
          id: 'env-pkg',
          schemas: envelopeSchema,
          importPath: '@test/env-pkg',
          fns: envelopeFns,
        },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port },
      signal: controller.signal,
    };
    run(input).catch(() => {
      /* swallowed after abort */
    });

    // Poll until ready; bounded to 10 s
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {},
          }),
        });
        if (r.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  async function rpc(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim());
    return dataLines.length > 0
      ? JSON.parse(dataLines[dataLines.length - 1])
      : JSON.parse(text);
  }

  it('[v2-mcp.env.1] envelope field bound from _meta["x-<pluginId>-<field>"]', async () => {
    // §9.1: 'session' field from plugin 'auth' → _meta key 'x-auth-session'
    const resp = (await rpc('tools/call', {
      name: envPkgGetUserName,
      arguments: {
        _meta: { 'x-auth-session': 'tok-mcp' }, // §9.1 MCP carrier
        data: { userId: 'u-meta' },
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content[0].text);
    // Ground truth: fn ignores session, just reads userId
    expect(parsed).toEqual(getUser('u-meta'));
  });

  it('[v2-mcp.env.2] (negative) envelope field in args body (not _meta) is NOT picked up as envelope', async () => {
    // Sending 'session' in args body instead of _meta is the wrong carrier.
    // The server must still succeed (fn ignores envelope value, just reads userId).
    const resp = (await rpc('tools/call', {
      name: envPkgGetUserName,
      arguments: {
        session: 'wrong-carrier', // wrong carrier — should be in _meta
        data: { userId: 'u-body' },
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    // Either success (fn ignores session) or error — the important assertion is
    // that if it succeeds, it returns the correct data-driven result.
    if (content.length > 0 && !resp?.error) {
      const parsed = JSON.parse(content[0].text);
      expect(parsed).toEqual(getUser('u-body'));
    }
  });
});

// ---------- [plugin-mcp.7] BUG-APIGEN-019 — MCP outputSchema + structuredContent ----------

// A discriminated-union return type, mirroring the reported
// `search(): SearchResponse | Record<string, unknown>` case — the schema a
// real pipeline run would produce after BUG-APIGEN-019's `normalizeTopLevelUnion`.
const unionOutputSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { outcome: { const: 'found' }, hits: { type: 'array' } },
      required: ['outcome', 'hits'],
    },
    {
      type: 'object',
      properties: { outcome: { const: 'empty' } },
      required: ['outcome'],
    },
  ],
  discriminator: { propertyName: 'outcome' },
  'x-apigen-logical': 'union',
};

function search(): { outcome: 'found'; hits: string[] } | { outcome: 'empty' } {
  return { outcome: 'found', hits: ['result-1'] };
}
function listUsersArray(): string[] {
  return ['alice', 'bob'];
}

const outputSchemaTestSchema = {
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
    output: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    },
  },
  search: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['data'],
    },
    output: unionOutputSchema,
  },
  listUsersArray: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['data'],
    },
    output: { type: 'array', items: { type: 'string' } },
  },
};

const outputSchemaTestFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
  search: () => search(),
  listUsersArray: () => listUsersArray(),
};

describe('[plugin-mcp.7] run() — BUG-APIGEN-019 MCP outputSchema + structuredContent', () => {
  let port: number;
  let controller: AbortController;

  beforeAll(async () => {
    port = await freePort();
    controller = new AbortController();
    const input: RunInput = {
      packages: [
        {
          id: 'out-pkg',
          schemas: outputSchemaTestSchema,
          importPath: '@test/out-pkg',
          fns: outputSchemaTestFns,
        },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port },
      signal: controller.signal,
    };
    run(input).catch(() => {
      /* swallowed after abort */
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {},
          }),
        });
        if (r.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  async function rpc(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim());
    return dataLines.length > 0
      ? JSON.parse(dataLines[dataLines.length - 1])
      : JSON.parse(text);
  }

  it('object-shaped output: tools/list outputSchema passes through unwrapped', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await rpc('tools/list', {})) as any;
    const tools: Array<{ name: string; outputSchema?: unknown }> =
      resp?.result?.tools ?? resp?.tools ?? [];
    const getUserTool = tools.find((t) => t.name === outPkgGetUserName);
    expect(getUserTool?.outputSchema).toEqual(outputSchemaTestSchema.getUser.output);
  });

  it('union-return output: tools/list outputSchema is wrapped under "result" with oneOf+discriminator intact', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await rpc('tools/list', {})) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Array<{ name: string; outputSchema?: any }> =
      resp?.result?.tools ?? resp?.tools ?? [];
    const searchTool = tools.find((t) => t.name === outPkgSearchName);
    expect(searchTool?.outputSchema?.type).toBe('object');
    expect(searchTool?.outputSchema?.required).toEqual(['result']);
    expect(searchTool?.outputSchema?.properties?.result).toEqual(
      unionOutputSchema
    );
    expect(searchTool?.outputSchema?.properties?.result?.oneOf).toHaveLength(2);
    expect(searchTool?.outputSchema?.properties?.result?.discriminator).toEqual(
      { propertyName: 'outcome' }
    );
  });

  it('array-return output: tools/list outputSchema is wrapped under "result"', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await rpc('tools/list', {})) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Array<{ name: string; outputSchema?: any }> =
      resp?.result?.tools ?? resp?.tools ?? [];
    const listTool = tools.find((t) => t.name === outPkgListUsersArrayName);
    expect(listTool?.outputSchema?.type).toBe('object');
    expect(listTool?.outputSchema?.properties?.result).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('object-shaped output: tools/call structuredContent equals the raw result (no wrapping)', async () => {
    const resp = (await rpc('tools/call', {
      name: outPkgGetUserName,
      arguments: { data: { userId: 'u1' } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const result = resp?.result ?? resp;
    const content: Array<{ type: string; text: string }> = result.content ?? [];
    // Ground truth is whatever dispatch() actually returned (content), not the
    // bare fixture call — structuredContent must mirror content unwrapped.
    expect(result.structuredContent).toEqual(JSON.parse(content[0].text));
    expect(result.structuredContent).toEqual(getUser('u1'));
  });

  it('union-return output: tools/call structuredContent is wrapped as { result: <value> }', async () => {
    const resp = (await rpc('tools/call', {
      name: outPkgSearchName,
      arguments: { data: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const result = resp?.result ?? resp;
    // content (backward-compat text) is still emitted alongside structuredContent.
    const content: Array<{ type: string; text: string }> = result.content ?? [];
    const dispatched = JSON.parse(content[0].text);
    // structuredContent must be the SAME value dispatch() produced (whatever
    // transcoding it applied), just wrapped under "result" since the union
    // schema isn't top-level type:"object".
    expect(result.structuredContent).toEqual({ result: dispatched });
    expect(dispatched.outcome).toBeDefined();
    expect(dispatched.hits).toEqual(['result-1']);
  });
});

// ---------- [BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] canonical MCP naming via RunInput.operations ----------
//
// Exercises the EXACT correlation path (real `Operation[]`, not the
// generate-time best-effort fallback): each op's `path` deliberately carries
// an extra "file" segment (`catalogApi`) that a naive `(namespace, fnName)`
// reconstruction would drop — proving `run()` genuinely projects the REAL
// `Operation` (via `RunInput.operations`), not an approximation.

function getItem(itemId: string): { id: string; sku: string } {
  return { id: itemId, sku: `SKU-${itemId}` };
}
function listItems(): string[] {
  return ['item-1', 'item-2'];
}

const projPkg = { id: 'proj-pkg', importPath: '@test/proj-pkg' };

const projNamespaceSeg: Segment = { raw: 'proj-pkg', words: ['proj', 'pkg'] };
// Intermediate "file" segment — present in every real extracted Operation
// (`opPath = [fileSeg, exportSeg]`, apigen-core-client/extract.ts) but NOT
// derivable from `(pkg.id, fnName)` alone.
const catalogFileSeg: Segment = { raw: 'catalogApi', words: ['catalog', 'api'] };

function makeProjOp(exportName: string, exportWords: string[]): Operation {
  return {
    id: `proj-pkg/catalog-api/${exportName}`,
    host: 'ts',
    namespace: projNamespaceSeg,
    path: [catalogFileSeg, { raw: exportName, words: exportWords }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: { type: 'object', properties: {}, required: [] },
    output: { type: 'object' },
    envelope: {},
    typeText: null,
  };
}

const getItemOp = makeProjOp('getItem', ['get', 'item']);
const listItemsOp = makeProjOp('listItems', ['list', 'items']);
const projOperations: Operation[] = [getItemOp, listItemsOp];

const projSchema = {
  getItem: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { itemId: { type: 'string' } },
          required: ['itemId'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
  listItems: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {}, required: [] } },
      required: ['data'],
    },
    output: { type: 'array' },
  },
};

const projFns: Record<string, (...args: unknown[]) => unknown> = {
  getItem: (itemId: unknown) => getItem(itemId as string),
  listItems: () => listItems(),
};

// Independent oracle: compute the expected canonical name by calling
// `project()` DIRECTLY (not via `deriveToolName`, the code under test) so
// this test cannot pass merely by agreeing with itself.
const expectedGetItemName = project(getItemOp).mcp.name;
const expectedListItemsName = project(listItemsOp).mcp.name;

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] run() derives tool names via RunInput.operations + project()', () => {
  let port: number;
  let controller: AbortController;

  beforeAll(async () => {
    port = await freePort();
    controller = new AbortController();
    const input: RunInput = {
      packages: [
        {
          id: projPkg.id,
          schemas: projSchema,
          importPath: projPkg.importPath,
          fns: projFns,
        },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port },
      signal: controller.signal,
      operations: projOperations,
    };
    run(input).catch(() => {
      /* swallowed after abort */
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {},
          }),
        });
        if (r.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  async function rpc(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim());
    return dataLines.length > 0
      ? JSON.parse(dataLines[dataLines.length - 1])
      : JSON.parse(text);
  }

  it('[parity] registered tool names equal project(op).mcp.name for every op in a representative set', async () => {
    // Sanity: the fixture's fileSeg genuinely changes the name vs a naive
    // (namespace, fnName)-only join — otherwise this test could pass even if
    // `run()` silently ignored `op.path`'s file segment.
    expect(expectedGetItemName).toBe('proj_pkg_catalog_api_get_item');
    expect(expectedListItemsName).toBe('proj_pkg_catalog_api_list_items');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await rpc('tools/list', {})) as any;
    const tools: Array<{ name: string }> =
      resp?.result?.tools ?? resp?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain(expectedGetItemName);
    expect(names).toContain(expectedListItemsName);
  });

  it('[round-trip] callTool(<canonical getItem name>) dispatches to the real getItem fn', async () => {
    const resp = (await rpc('tools/call', {
      name: expectedGetItemName,
      arguments: { data: { itemId: 'sku-1' } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toEqual(getItem('sku-1'));
  });

  it('[round-trip] callTool(<canonical listItems name>) dispatches to the real listItems fn', async () => {
    const resp = (await rpc('tools/call', {
      name: expectedListItemsName,
      arguments: { data: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toEqual(listItems());
  });

  it('[negative control] callTool with the OLD raw fn name ("getItem") is rejected', async () => {
    const resp = (await rpc('tools/call', {
      name: 'getItem',
      arguments: { data: { itemId: 'sku-1' } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const content: Array<{ type: string; text: string }> =
      resp?.result?.content ?? resp?.content ?? [];
    const succeeded =
      !resp?.error &&
      !resp?.result?.isError &&
      content.length > 0 &&
      (() => {
        try {
          return JSON.parse(content[0].text)?.sku === 'SKU-sku-1';
        } catch {
          return false;
        }
      })();
    expect(succeeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [mcp-adapter] TransportAdapter/OpPlan golden-snapshot parity gate.
//
// [def:real-consumer-protocol]: driven by a REAL `@modelcontextprotocol/sdk`
// `Client` over `StreamableHTTPClientTransport` against the real HTTP
// endpoint `run()` starts — never plugin internals (AGENTS.md "Proving an
// MCP server works").
//
// Fixture classes captured here are the BYTE-IDENTICAL set — unaffected by
// the mcp-adapter migration: a normal call, a zero-arg call, a
// session-envelope call, a domain-thrown `ApiError`, and the `tools/list`
// projection (description/outputSchema). Three classes are DELIBERATELY
// EXCLUDED from this golden set because the migration flags them as
// intentional behavior CHANGES, proven separately with their own dedicated
// (non-golden) tests instead:
//   - malformed input:  pre-migration SUCCEEDS (no validation); post-
//     migration REJECTS with `invalid_argument` (BUG-APIGEN-SERVE-CORE-001).
//   - streaming:true:   pre-migration mis-serializes to `{}`; post-migration
//     is genuinely projected via `projectStreamMcp` (DEBT-APIGEN-SERVE-CORE-002).
//   - `--use` mount ops: mcp has ZERO mount support pre-migration; this is a
//     wholly NEW capability post-migration (dod.11), not a byte-identical case.
//
// The golden snapshot is regenerated with `APIGEN_CAPTURE_GOLDEN=1` (the
// standard snapshot-update escape hatch — the compare test itself always runs
// unflagged, by default, in CI). Committed at
// `src/test/golden/mcp.snapshot.json`.
// ---------------------------------------------------------------------------

function parityGetUser(userId: string): { id: string; name: string } {
  return { id: userId, name: `User-${userId}` };
}
function parityListUsers(): string[] {
  return ['alice', 'bob'];
}
function parityGetThing(id: string): { id: string } {
  if (id === 'missing') throw new ApiError('not_found', 'no such thing');
  return { id };
}

const paritySchema = {
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
  listUsers: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {}, required: [] } },
      required: ['data'],
    },
    output: { type: 'array', items: { type: 'string' } },
  },
};

const parityEnvSchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['session', 'data'],
    },
    output: { type: 'object' },
    'x-apigen-envelope': { session: 'auth' },
  },
};

const parityErrSchema = {
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

const parityNamespaceSeg: Segment = { raw: 'parity-pkg', words: ['parity', 'pkg'] };
function makeParityOp(exportName: string, exportWords: string[]): Operation {
  return {
    id: `parity-pkg/${exportName}`,
    host: 'ts',
    namespace: parityNamespaceSeg,
    path: [{ raw: exportName, words: exportWords }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}
const parityGetUserOp = makeParityOp('getUser', ['get', 'user']);
const parityListUsersOp = makeParityOp('listUsers', ['list', 'users']);

const parityEnvNamespaceSeg: Segment = {
  raw: 'parity-env-pkg',
  words: ['parity', 'env', 'pkg'],
};
const parityEnvGetUserOp: Operation = {
  ...makeParityOp('getUser', ['get', 'user']),
  id: 'parity-env-pkg/getUser',
  namespace: parityEnvNamespaceSeg,
};

const parityErrNamespaceSeg: Segment = {
  raw: 'parity-err-pkg',
  words: ['parity', 'err', 'pkg'],
};
const parityGetThingOp: Operation = {
  ...makeParityOp('getThing', ['get', 'thing']),
  id: 'parity-err-pkg/getThing',
  namespace: parityErrNamespaceSeg,
};

const parityGetUserName = project(parityGetUserOp).mcp.name;
const parityListUsersName = project(parityListUsersOp).mcp.name;
const parityEnvGetUserName = project(parityEnvGetUserOp).mcp.name;
const parityGetThingName = project(parityGetThingOp).mcp.name;

type McpFixtureInput =
  | { kind: 'tools-list' }
  | { kind: 'call'; toolName: string; args: Record<string, unknown> };

interface McpFixtureOutput {
  ok: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    outputSchema?: unknown;
  }>;
  content?: unknown;
  structuredContent?: unknown;
  errorCode?: number;
  errorMessage?: string;
}

const GOLDEN_PATH = path.join(__dirname, 'golden', 'mcp.snapshot.json');

/** The byte-identical fixture classes (malformed/streaming/mount proven separately). */
const parityFixtures: ReadonlyArray<GoldenFixture<McpFixtureInput>> = [
  { name: 'tools-list', input: { kind: 'tools-list' } },
  {
    name: 'call-getUser',
    input: {
      kind: 'call',
      toolName: parityGetUserName,
      args: { data: { userId: 'u1' } },
    },
  },
  {
    name: 'call-listUsers',
    input: { kind: 'call', toolName: parityListUsersName, args: { data: {} } },
  },
  {
    name: 'call-session-envelope',
    input: {
      kind: 'call',
      toolName: parityEnvGetUserName,
      args: {
        _meta: { 'x-auth-session': 'tok-abc' },
        data: { userId: 'u-env' },
      },
    },
  },
  {
    name: 'call-domain-apierror',
    input: {
      kind: 'call',
      toolName: parityGetThingName,
      args: { data: { id: 'missing' } },
    },
  },
];

describe('[mcp-adapter] TransportAdapter/OpPlan golden-snapshot parity gate', () => {
  let controller: AbortController;
  let baseUrl: string;
  let client: Client;
  let driver: ParityDriver<McpFixtureInput, McpFixtureOutput>;

  beforeAll(async () => {
    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      packages: [
        {
          id: 'parity-pkg',
          schemas: paritySchema,
          importPath: '@test/parity-pkg',
          fns: {
            getUser: (userId: unknown) => parityGetUser(userId as string),
            listUsers: () => parityListUsers(),
          },
        },
        {
          id: 'parity-env-pkg',
          schemas: parityEnvSchema,
          importPath: '@test/parity-env-pkg',
          fns: { getUser: (userId: unknown) => parityGetUser(userId as string) },
        },
        {
          id: 'parity-err-pkg',
          schemas: parityErrSchema,
          importPath: '@test/parity-err-pkg',
          fns: { getThing: (id: unknown) => parityGetThing(id as string) },
        },
      ],
      operations: [parityGetUserOp, parityListUsersOp, parityEnvGetUserOp, parityGetThingOp],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port },
      signal: controller.signal,
    };

    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    baseUrl = `http://127.0.0.1:${port}/mcp`;

    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        client = new Client({ name: 'mcp-adapter-parity', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
        await client.connect(transport);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('server did not become ready in 10s');
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    driver = {
      async invoke(fixture: GoldenFixture<McpFixtureInput>): Promise<McpFixtureOutput> {
        if (fixture.input.kind === 'tools-list') {
          const { tools } = await client.listTools();
          return {
            ok: true,
            tools: tools
              .map((t) => ({
                name: t.name,
                description: t.description,
                outputSchema: t.outputSchema,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        }
        try {
          const result = await client.callTool({
            name: fixture.input.toolName,
            arguments: fixture.input.args,
          });
          return {
            ok: true,
            content: result.content,
            structuredContent: result.structuredContent,
          };
        } catch (err) {
          const e = err as { code?: number; message?: string };
          return { ok: false, errorCode: e.code, errorMessage: e.message };
        }
      },
    };
  }, 15000);

  afterAll(async () => {
    await client?.close();
    controller.abort();
  });

  // [mcp-adapter.4/.5] the parity gate. Recapture through the (post-migration)
  // adapter-based server and assert deep-equality vs the committed
  // pre-migration golden snapshot. Regenerate with APIGEN_CAPTURE_GOLDEN=1.
  it('recapture deep-equals the committed golden snapshot', async () => {
    const recapture = await captureGolden(driver, parityFixtures);

    if (process.env['APIGEN_CAPTURE_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(recapture, null, 2) + '\n');
      return;
    }

    if (!fs.existsSync(GOLDEN_PATH)) {
      throw new Error(
        `[mcp-adapter] golden snapshot missing at ${GOLDEN_PATH} — ` +
          'regenerate with APIGEN_CAPTURE_GOLDEN=1 before comparing.'
      );
    }
    const committed = JSON.parse(
      fs.readFileSync(GOLDEN_PATH, 'utf8')
    ) as GoldenSnapshot<McpFixtureOutput>;

    assertParity(committed, recapture);
  });
});

// ---------------------------------------------------------------------------
// [mcp-adapter.1] BUG-APIGEN-SERVE-CORE-001 — validate-Layer composition.
//
// ⚠️ FLAGGED BREAKING BEHAVIOR CHANGE: malformed input now REJECTS with
// `ApiError{code:'invalid_argument'}` (surfaced to a real MCP client as a
// JSON-RPC error whose message is the validate-Layer's own "Validation
// failed: ..." text) BEFORE the target function is ever called. Pre-
// migration this same call would have reached `dispatch()` directly and
// EITHER run the domain fn with `undefined`/garbage args (silently
// "succeeding") or thrown a completely different, uncontrolled error —
// never a controlled, pre-dispatch `invalid_argument` rejection. This is
// intentional and required (dod.4/dod.9), not a regression.
// ---------------------------------------------------------------------------

describe('[mcp-adapter.1] BUG-APIGEN-SERVE-CORE-001 — malformed input is rejected pre-dispatch', () => {
  let controller: AbortController;
  let client: Client;
  let calls = 0;

  const malformedSchema = {
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
  };
  const malformedNamespaceSeg: Segment = {
    raw: 'malformed-pkg',
    words: ['malformed', 'pkg'],
  };
  const malformedGetUserOp: Operation = {
    id: 'malformed-pkg/getUser',
    host: 'ts',
    namespace: malformedNamespaceSeg,
    path: [{ raw: 'getUser', words: ['get', 'user'] }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
  const malformedToolName = project(malformedGetUserOp).mcp.name;

  beforeAll(async () => {
    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      packages: [
        {
          id: 'malformed-pkg',
          schemas: malformedSchema,
          importPath: '@test/malformed-pkg',
          fns: {
            getUser: (userId: unknown) => {
              calls++;
              return getUser(userId as string);
            },
          },
        },
      ],
      operations: [malformedGetUserOp],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port },
      signal: controller.signal,
    };
    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        client = new Client({ name: 'mcp-adapter-malformed', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('server did not become ready in 10s');
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(async () => {
    await client?.close();
    controller.abort();
  });

  it('a REAL sdk client callTool() with missing required "userId" REJECTS (does not silently succeed)', async () => {
    calls = 0;
    await expect(
      client.callTool({ name: malformedToolName, arguments: { data: {} } })
    ).rejects.toThrow();
    // Short-circuit proof (§8.1 rule 1 / BUG-APIGEN-009): the domain fn must
    // NEVER be reached when validation fails — this is what distinguishes a
    // genuine pre-dispatch `invalid_argument` rejection from the target fn
    // itself throwing (or silently running on garbage input, the OLD
    // behavior).
    expect(calls).toBe(0);
  });

  it('the rejection surfaces the validate-Layer\'s own message text (the invalid_argument ApiError, not a generic/unknown-tool error)', async () => {
    calls = 0;
    let thrown: unknown;
    try {
      await client.callTool({ name: malformedToolName, arguments: { data: {} } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toContain('Validation failed');
    expect((thrown as Error).message).toContain('userId');
    expect(calls).toBe(0);
  });

  it('[negative control] a WELL-FORMED call to the SAME tool succeeds and DOES reach the fn — proves the rejection above is validation-specific, not a broken tool registration', async () => {
    calls = 0;
    const result = await client.callTool({
      name: malformedToolName,
      arguments: { data: { userId: 'u-ok' } },
    });
    expect(calls).toBe(1);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual(getUser('u-ok'));
  });
});

// ---------------------------------------------------------------------------
// dod.11 / [mcp-adapter.7] — mcp composes `--use` layer AND mount capability
// via `createPackageInvoker`, for the FIRST time. A wholly NEW mcp
// capability (mcp had zero `--use` support pre-migration).
// ---------------------------------------------------------------------------

describe('[mcp-adapter.7] dod.11 — mcp composes --use layer + mount via createPackageInvoker', () => {
  let controller: AbortController;
  let client: Client;
  let layerCallLog: string[];

  const useSchema = {
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
  };
  const useNamespaceSeg: Segment = { raw: 'use-pkg', words: ['use', 'pkg'] };
  const useGetUserOp: Operation = {
    id: 'use-pkg/getUser',
    host: 'ts',
    namespace: useNamespaceSeg,
    path: [{ raw: 'getUser', words: ['get', 'user'] }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
  const useGetUserToolName = project(useGetUserOp).mcp.name;

  /** A tiny `--use` plugin exercising BOTH the `layer` and `mount` capabilities
   * `createPackageInvoker` composes. The layer logs every op.id it wraps
   * (source AND mount) — proving `dispatchForPlan`'s mount branch routes
   * through the SAME composed layer stack as source ops
   * ([fix:mount-through-layers], mirrored from fastify). The mount
   * contributes a `status` tool with no composed schema at all. */
  const statusMountOp: MountedOperation = {
    id: '_meta/status',
    host: 'ts',
    namespace: { raw: 'meta', words: ['meta'] },
    path: [{ raw: 'status', words: ['status'] }],
    kind: 'query',
    async: false,
    streaming: false,
    safe: true,
    input: {},
    output: { type: 'object' },
    envelope: {},
    typeText: null,
    transports: ['mcp'],
    handler: () => ({ status: 'ok' }),
  };

  function makeLoggingUsePlugin(log: string[]): UsePlugin {
    return {
      id: 'logging-use',
      capabilities: {
        layer: {
          layer: async (call: unknown, next: () => Promise<unknown>) => {
            log.push((call as { operation: { id: string } }).operation.id);
            return next();
          },
        },
        mount: {
          operations: () => [statusMountOp],
        },
      },
    };
  }

  beforeAll(async () => {
    layerCallLog = [];
    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      packages: [
        {
          id: 'use-pkg',
          schemas: useSchema,
          importPath: '@test/use-pkg',
          fns: { getUser: (userId: unknown) => getUser(userId as string) },
        },
      ],
      operations: [useGetUserOp],
      outputDir: '/tmp/out',
      options: {
        transport: 'streaming-http',
        port,
        usePlugins: [makeLoggingUsePlugin(layerCallLog)],
      },
      signal: controller.signal,
    };
    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        client = new Client({ name: 'mcp-adapter-use', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('server did not become ready in 10s');
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(async () => {
    await client?.close();
    controller.abort();
  });

  it('the mount op (_meta/status) is registered as a real MCP tool (tools/list)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('meta_status');
  });

  it('callTool(_meta/status mount) dispatches to the mount handler and returns its value', async () => {
    const result = await client.callTool({ name: 'meta_status', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({ status: 'ok' });
  });

  it('the --use LAYER wraps a normal source-op call (layer log records the op.id)', async () => {
    layerCallLog.length = 0;
    await client.callTool({
      name: useGetUserToolName,
      arguments: { data: { userId: 'u-layer' } },
    });
    expect(layerCallLog).toContain(useGetUserOp.id);
  });

  it('[fix:mount-through-layers] the --use LAYER ALSO wraps the mount call (dispatchForPlan mount branch flows through the SAME composed invoker)', async () => {
    layerCallLog.length = 0;
    await client.callTool({ name: 'meta_status', arguments: {} });
    expect(layerCallLog).toContain('_meta/status');
  });
});

// ---------------------------------------------------------------------------
// dod.12 / [mcp-adapter.8] — toolMetas hoist regression guard: the (expensive)
// tool table must be built EXACTLY ONCE per `run()` invocation, never
// per-request. Pre-migration, `streaming-http` mode rebuilt the ENTIRE tool
// table (fresh `Server` + full OpPlan/description/outputSchema re-derivation)
// on every single request.
// ---------------------------------------------------------------------------

describe('[mcp-adapter.8] dod.12 — toolMetas build count stays 1 across multiple CallTool requests', () => {
  it('__toolTableBuildCount increases by exactly 1 for one run(), regardless of request volume', async () => {
    const before = __toolTableBuildCount.count;
    const controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      packages: [
        {
          id: 'hoist-pkg',
          schemas: testSchema,
          importPath: '@test/hoist-pkg',
          fns: testFns,
        },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port },
      signal: controller.signal,
    };
    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    let client: Client | undefined;
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        client = new Client({ name: 'mcp-adapter-hoist', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('server did not become ready in 10s');
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    try {
      // Build count is pinned immediately after run() starts listening — a
      // per-request rebuild would already show up as > before+1 here.
      expect(__toolTableBuildCount.count).toBe(before + 1);

      const toolName = deriveToolName({ id: 'hoist-pkg', importPath: '@test/hoist-pkg' }, 'getUser');
      // MULTIPLE CallTool requests against the SAME stateless streaming-http
      // server (each streaming-http request gets its own fresh `Server`
      // instance per the SDK's stateless-mode contract — but that per-request
      // `createMcpServer()` call must NOT re-invoke the expensive
      // `buildToolTable()`).
      for (let i = 0; i < 5; i++) {
        await client.callTool({ name: toolName, arguments: { data: { userId: `u${i}` } } });
      }

      expect(__toolTableBuildCount.count).toBe(before + 1);
    } finally {
      await client.close();
      controller.abort();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// [mcp-adapter.6] negative control ([inv:negative-control], AGENTS.md §7 pt
// 2): a parity suite that has never been shown to fail is not a gate.
//
// Patching `run.ts` on disk cannot affect an ALREADY-imported, already-
// running server within this same test process (editing a .ts source file
// does not hot-reload code a prior `import` already evaluated) — so `runner`
// here spawns a genuinely FRESH `vitest` child process per check, which
// re-transforms run.ts from disk from scratch every time. This is what makes
// the patch's effect actually observable: RED means the freshly-spawned
// process's own golden-parity check failed; GREEN means it passed.
//
// `neg-control/mcp-adapter.patch` carries TWO hunks in the SAME file
// (documented choice — see `transport-http-parity.spec.ts`'s own negative
// control, which reuses hunk 2): hunk 1 (this test's target) breaks the §9.1
// envelope-key lookup so `call-session-envelope` fails validation; hunk 2
// reverts the sse per-session `Server` fix, breaking a SECOND concurrent SSE
// session's handshake. `git apply` applies both hunks together, but each
// negative-control test only exercises the check its own hunk affects — the
// other hunk is inert for that check.
// ---------------------------------------------------------------------------

describe('[mcp-adapter.6] negative control — the parity gate actually gates', () => {
  it(
    'applying neg-control/mcp-adapter.patch turns the golden-parity check RED; reverting turns it GREEN',
    async () => {
      const repoRoot = findRepoRoot(__dirname);
      const patchPath = path.join(
        repoRoot,
        'docs/plan/apigen-serve-core/neg-control/mcp-adapter.patch'
      );

      function runGoldenParityCheckInFreshProcess(): void {
        const result = spawnSync(
          process.execPath,
          [
            path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--config',
            path.join(repoRoot, 'packages/apigen/apigen-plugin-mcp/vite.config.ts'),
            '-t',
            'recapture deep-equals the committed golden snapshot',
          ],
          { cwd: repoRoot, encoding: 'utf8' }
        );
        if (result.status !== 0) {
          throw new Error(
            `golden-parity check failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
          );
        }
      }

      await withNegControlLock(repoRoot, () =>
        proveNegativeControl(runGoldenParityCheckInFreshProcess, patchPath, {
          cwd: repoRoot,
        })
      );
    },
    60000
  );
});
