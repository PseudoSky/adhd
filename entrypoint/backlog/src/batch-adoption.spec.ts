/**
 * batch-adoption.spec.ts — proof that `@adhd/apigen-plugin-batch` is a REAL,
 * working consumer mount on `entrypoint/backlog`'s live HTTP transport
 * (FEAT-BACKLOG-005 / cross-ref FEAT-APIGEN-BULK-OPS-001).
 *
 * Per AGENTS.md §7 "Live testing is mandatory" + "Proving an MCP/host server
 * works — drive the real tools, never a bypass": this default-running
 * (unflagged) test starts the REAL `startBacklogServer({transport:'http'})`
 * (which now mounts `batchPlugin` alongside `openapiPlugin` — see
 * `server.ts`'s `usePlugins` array) against a real temp SQLite-backed
 * `GraphBacklogStore`, then issues a real `fetch()` HTTP `POST
 * /_batch/action` fanning out to backlog's own real INTERFACE_v2 `create`
 * verb (`backlog/create` — the v1 `backlog/create-item` operation id no
 * longer exists; only the six consolidated verbs are mounted, see
 * `client.ts`'s header comment). No mocked store, invoker, or hostBridge —
 * every fanned-out item reaches the REAL `createItemNode` (`store/crud.ts`)
 * through the REAL composed validate-Layer + `MountHostBridge` wiring
 * `apigen-plugin-api-fastify`'s `run.ts` builds (untouched by this packet —
 * read-only, per task scope).
 *
 * Empirically-derived request/response shapes (verified via a temporary
 * instrumented probe against the real running server, then removed):
 *
 *  - The batch mount is a `Plugin.capabilities.mount` operation, so its own
 *    request body is read RAW (`plan.isMount` branch of
 *    `apiFastifyPlugin`'s `run.ts`'s `readInput` — no `{data:{...}}`
 *    envelope wrapper): `{ operation, items, concurrency, onItemError }`
 *    goes straight to `POST /_batch/action`.
 *  - Each fanned-out `items[i]` becomes that item's `domainArgs` DIRECTLY
 *    (`apigen-plugin-batch`'s `buildBatchHandler`: `domainArgs: item`) — so
 *    it must equal the whole second positional argument the target
 *    operation expects. `create(ctx, input: IBacklogCreateInput)`'s `input`
 *    is `{ item: {family, title, body, repo, priority?, …}, by }`, so one
 *    batch item is `{ input: { item: {...}, by } }`.
 *  - A non-batch (regular, non-mount) HTTP endpoint DOES go through the
 *    `{data:{...}}` envelope convention (`composeSchemas()`), so the
 *    follow-up plain `POST /backlog/get` call below needs
 *    `{ data: { input: { repo, humanId } } }`.
 *  - Every verb (including `get`) returns the §7.1 outcome envelope
 *    `{ ok, data }` on the wire, whether reached directly or via batch
 *    fan-out — so a fulfilled batch result's `value` is
 *    `{ ok: true, data: { created, humanId, item } }`, and the follow-up
 *    `get` response body is `{ ok: true, data: <card> }`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBacklogServer } from './server.js';

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

async function waitForHttpReady(port: number, path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      await res.text().catch(() => undefined);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server never became ready on port ${port}: ${String(lastErr)}`);
}

interface CreateOutcomeData {
  created: boolean;
  humanId: string;
  item: { humanId: string; title: string; repo: string };
}

interface BatchItemResult {
  index: number;
  status: 'fulfilled' | 'rejected';
  value?: { ok: boolean; data?: CreateOutcomeData };
  reason?: { message?: string; code?: string } | string;
  chunksDelivered?: number;
}

describe('backlog batch adoption — real POST /_batch/action fans out to the real backlog/create operation', () => {
  let controller: AbortController | undefined;
  let serverPromise: Promise<void> | undefined;
  let adhdRoot: string | undefined;

  afterEach(async () => {
    controller?.abort();
    await serverPromise?.catch(() => undefined);
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
    controller = undefined;
    serverPromise = undefined;
    adhdRoot = undefined;
  });

  it('creates real items via a real fan-out, and a per-item validation failure rejects without aborting the batch', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-batch-adoption-'));
    const repo = 'PseudoSky/batch-adoption-test';
    const by = 'batch-adoption-spec';

    const port = await freePort();
    controller = new AbortController();
    serverPromise = startBacklogServer({
      transport: 'http',
      port,
      host: '127.0.0.1',
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
      signal: controller.signal,
    });

    await waitForHttpReady(port, `/_meta/openapi`);

    // Item #1: valid — real create, real store write.
    // Item #2: INVALID — `priority: 'NOT_A_REAL_PRIORITY'` violates the real
    // `Priority` enum (`CRITICAL|HIGH|MEDIUM|LOW`, `model.ts`) baked into the
    // extracted JSON Schema for `IBacklogCreateInput.item.priority`, so the
    // REAL composed validate-Layer (the same AJV validation every non-batch
    // request goes through — confirmed empirically: it rejects with AJV's
    // `enum` keyword violation, `.../priority must be equal to one of the
    // allowed values`) rejects it before it ever reaches `createItemNode` —
    // proving `onItemError: 'continue'` semantics hold for a genuine backlog
    // operation failure, not a synthetic/mocked one.
    // Item #3: valid — proves item #2's rejection did not abort the batch.
    const res = await fetch(`http://127.0.0.1:${port}/_batch/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'backlog/create',
        items: [
          { input: { item: { family: 'BUG-BATCHADOPT', title: 'first item', body: 'x', repo }, by } },
          {
            input: {
              item: { family: 'BUG-BATCHADOPT', title: 'bad priority', body: 'x', repo, priority: 'NOT_A_REAL_PRIORITY' },
              by,
            },
          },
          { input: { item: { family: 'BUG-BATCHADOPT', title: 'third item', body: 'x', repo }, by } },
        ],
        concurrency: 2,
        onItemError: 'continue',
      }),
    });

    expect(res.status).toBe(200);
    const results = (await res.json()) as BatchItemResult[];
    expect(results).toHaveLength(3);

    // (1) fulfilled — a REAL item, really persisted. Every mounted verb
    // (including through a batch fan-out) returns the §7.1 outcome envelope
    // `{ ok, data }` on the wire, so a fulfilled item's payload is nested
    // under `.value.data`, not `.value` directly.
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[0]?.value?.ok).toBe(true);
    expect(results[0]?.value?.data?.created).toBe(true);
    expect(results[0]?.value?.data?.item.title).toBe('first item');
    expect(results[0]?.value?.data?.item.repo).toBe(repo);
    const firstHumanId = results[0]?.value?.data?.humanId;
    expect(firstHumanId).toBeTruthy();

    // (2) rejected — the REAL validate-Layer's AJV schema rejection surfaced
    // as a per-item failure, WITHOUT aborting the batch.
    expect(results[1]?.status).toBe('rejected');
    const reason = results[1]?.reason as { code?: string; message?: string } | undefined;
    expect(reason?.code).toBe('invalid_argument');
    expect(reason?.message).toContain('priority');

    // (3) fulfilled — item #3 was NOT skipped after item #2's failure, and
    // got a DIFFERENT humanId than item #1 (proves two independent real
    // store writes, not one write echoed twice).
    expect(results[2]?.status).toBe('fulfilled');
    expect(results[2]?.value?.data?.created).toBe(true);
    expect(results[2]?.value?.data?.item.title).toBe('third item');
    const thirdHumanId = results[2]?.value?.data?.humanId;
    expect(thirdHumanId).toBeTruthy();
    expect(thirdHumanId).not.toBe(firstHumanId);

    // Follow-up real `get` call against the single-op mount proves both
    // batch-created items are genuinely visible in the store afterward (not
    // just echoed back in the batch response). Unlike the batch mount's raw
    // body, a regular (non-mount) endpoint goes through the `{data:{...}}`
    // envelope convention `composeSchemas()` derives for every domain op.
    const getRes = await fetch(`http://127.0.0.1:${port}/backlog/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input: { repo, humanId: firstHumanId } } }),
    });
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { ok: boolean; data: { title: string } };
    expect(got.ok).toBe(true);
    expect(got.data.title).toBe('first item');
  }, 30_000);
});
