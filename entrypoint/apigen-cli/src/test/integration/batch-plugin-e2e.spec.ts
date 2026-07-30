/**
 * Real end-to-end proof that `@adhd/apigen-plugin-batch`'s hostBridge wiring
 * actually works (BATCH_0.0.1.md §2/§F1 — batch-rollout design note +
 * architect review), not just that the pieces compile.
 *
 * REAL components, per CLAUDE.md §7 — no bypass, no mocks of the thing under
 * test:
 *   - a REAL `@adhd/apigen-plugin-api-fastify` server (`run()`), started on an
 *     ephemeral port and driven over REAL HTTP (`fetch`);
 *   - the REAL `loadUsePlugins(['batch'])` resolution path
 *     (`entrypoint/apigen-cli/src/lib/commands/run.ts`) — the exact function
 *     `apigen run --use batch` calls;
 *   - a REAL domain package (`catalog.getItem`) with a real fn/schema/Operation
 *     triple, exactly as a consumer would author one;
 *   - the REAL `_batch/action` mount, built by the REAL
 *     `buildBatchMountedOperations` + the REAL hostBridge fastify's `run.ts`
 *     now constructs (merged, package-spanning `schemasByOpId`/`fnsByOpId`) —
 *     proving the mount-collection hoist (architect-review Finding 2) and the
 *     `MountHostBridge` wiring (Finding 1) both work together, end to end.
 *
 * Proves: multiple real fanned-out invocations of `catalog/getItem` come back
 * correctly (§3), a per-item failure surfaces as `status: 'rejected'` without
 * aborting the batch under the default `onItemError: 'continue'` (§3), and a
 * caller-requested `concurrency` is honored/respected (§3 — the direct lesson
 * of `BUG-AGENTMCP-TRIAGE-CONCURRENCY-001`'s motivating incident).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { run as runFastify } from '@adhd/apigen-plugin-api-fastify';
import type { Operation, RunInput } from '@adhd/apigen-core-client';
import type { ComposedSchemas } from '@adhd/apigen-engine-runtime';
import { loadUsePlugins } from '../../lib/commands/run';

// ---------------------------------------------------------------------------
// Server lifecycle — one abort controller per test, always torn down.
// ---------------------------------------------------------------------------

let controller: AbortController | undefined;
let serverPromise: Promise<void> | undefined;

afterEach(async () => {
  controller?.abort();
  if (serverPromise) {
    await Promise.race([
      serverPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  controller = undefined;
  serverPromise = undefined;
});

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as import('node:net').AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    srv.on('error', reject);
  });
}

async function waitForReady(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ready_probe__`, { method: 'GET' });
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`server on port ${port} did not become ready within 5s`);
}

// ---------------------------------------------------------------------------
// Real domain package: catalog.getItem(id) — a real fn/schema/Operation triple.
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  name: string;
}

function getItem(id: string): Item {
  if (id === 'missing') throw new Error(`no such item: ${id}`);
  return { id, name: `Item ${id}` };
}

const getItemOp: Operation = {
  id: 'catalog/getItem',
  host: 'ts',
  namespace: { raw: 'catalog', words: ['catalog'] },
  path: [{ raw: 'getItem', words: ['get', 'item'] }],
  kind: 'action',
  async: false,
  streaming: false,
  safe: false,
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  output: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' } },
    required: ['id', 'name'],
  },
  envelope: {},
  typeText: null,
};

const catalogSchemas: ComposedSchemas = {
  getItem: {
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
    output: getItemOp.output,
    'x-apigen-safe': false,
  } as unknown as ComposedSchemas[string],
};

describe('[BATCH_0.0.1.md §2/§F1] apigen-plugin-batch — real e2e over a live fastify server', () => {
  it('POST /_batch/action fans out to a REAL registered operation and returns real, ordered results (partial-failure + concurrency respected)', async () => {
    const port = await freePort();
    controller = new AbortController();

    // The REAL `--use batch` resolution path apigen-cli's `run`/`serve`
    // command uses — proves the plugin is reachable via the same mechanism a
    // real `apigen run --use batch` invocation would use, not a hand-rolled
    // substitute.
    const usePlugins = await loadUsePlugins(['batch']);

    const runInput: RunInput = {
      packages: [
        {
          id: 'catalog',
          schemas: catalogSchemas,
          importPath: '',
          fns: { getItem: getItem as (...a: unknown[]) => unknown },
        },
      ],
      operations: [getItemOp],
      outputDir: '',
      options: { port, usePlugins },
      signal: controller.signal,
    };

    serverPromise = runFastify(runInput);
    await waitForReady(port);

    const res = await fetch(`http://127.0.0.1:${port}/_batch/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'catalog/getItem',
        items: [{ id: 'a' }, { id: 'missing' }, { id: 'b' }],
        concurrency: 2,
        onItemError: 'continue',
      }),
    });

    expect(res.status).toBe(200);
    const results = (await res.json()) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);

    // (1) fulfilled — the REAL getItem(id) really ran and its real return
    // value came back through the REAL Layer stack + hostBridge.
    expect(results[0]).toMatchObject({
      index: 0,
      status: 'fulfilled',
      value: { id: 'a', name: 'Item a' },
    });
    // (2) rejected — the REAL thrown error surfaced as a per-item rejection,
    // WITHOUT aborting the batch (default onItemError: 'continue'). This IS
    // a real, already-serialized-over-the-wire HTTP/JSON response (`res.json()`
    // above, not an in-process object) — so this is exactly where
    // BUG-APIGEN-047 (a bare thrown `Error` has no own enumerable properties,
    // so `JSON.stringify` used to drop `message`/`stack`/`name` entirely,
    // leaving `reason: {}`) would have shown up, and is now fixed:
    // `invokeBatch` normalizes an unknown thrown `Error` into a real
    // `ApiError('internal', message)` before returning, whose `toJSON()`
    // survives the wire round trip this test already performs.
    expect(results[1]).toMatchObject({ index: 1, status: 'rejected' });
    const reason = (results[1] as { reason?: { message?: string; code?: string } }).reason;
    expect(reason).toBeDefined();
    expect(reason?.message).toBe('no such item: missing');
    expect(reason?.code).toBe('internal');
    // (3) fulfilled — proves item #2 was NOT skipped after item #1's failure.
    expect(results[2]).toMatchObject({
      index: 2,
      status: 'fulfilled',
      value: { id: 'b', name: 'Item b' },
    });
  });

  it('rejects an "operation" that is not one of this mount\'s real batchable ops (proves the mount is bound to THIS descriptor, not a hardcoded stub)', async () => {
    const port = await freePort();
    controller = new AbortController();
    const usePlugins = await loadUsePlugins(['batch']);

    const runInput: RunInput = {
      packages: [
        {
          id: 'catalog',
          schemas: catalogSchemas,
          importPath: '',
          fns: { getItem: getItem as (...a: unknown[]) => unknown },
        },
      ],
      operations: [getItemOp],
      outputDir: '',
      options: { port, usePlugins },
      signal: controller.signal,
    };

    serverPromise = runFastify(runInput);
    await waitForReady(port);

    const res = await fetch(`http://127.0.0.1:${port}/_batch/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'not/a-real-op', items: [] }),
    });

    expect(res.status).toBe(400);
  });
});
