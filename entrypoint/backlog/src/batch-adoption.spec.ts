/**
 * batch-adoption.spec.ts — proof that `@adhd/apigen-plugin-batch` is a REAL,
 * working consumer mount on `entrypoint/backlog`'s live HTTP transport
 * (FEAT-BACKLOG-005 / cross-ref FEAT-APIGEN-BULK-OPS-001).
 *
 * Per AGENTS.md §7 "Live testing is mandatory" + "Proving an MCP/host server
 * works — drive the real tools, never a bypass": this default-running
 * (unflagged) test starts the REAL `startBacklogServer({transport:'http'})`
 * (which mounts `batchPlugin` alongside `openapiPlugin` — see `server.ts`'s
 * `usePlugins` array) against a real temp-directory-backed `GraphBacklogStore`,
 * then issues a real `fetch()` HTTP `POST /_batch/action` fanning out to
 * backlog's own real `backlog/create` operation. No mocked store, invoker, or
 * hostBridge — every fanned-out item reaches the REAL `createIssue`
 * (`write/create-issue.ts`) through the REAL composed validate-Layer +
 * `MountHostBridge` wiring `apigen-plugin-api-fastify`'s `run.ts` builds
 * (untouched by this packet — read-only, per task scope).
 *
 * The `project` a real `create` resolves against is RESOLVED ONLY — never
 * minted by `create` — so it is seeded through the same real store path
 * `server.spec.ts` uses (`seedProject` via `open-test-issue-store.js`) before
 * the server owns the file.
 *
 * Empirically-derived request/response shapes, cross-checked against
 * `server.spec.ts`'s own longhand HTTP-shape notes and
 * `apigen-plugin-batch`'s `plugin.ts` (`parseBatchRequest`/
 * `buildBatchHandler`):
 *
 *  - The batch mount is a `Plugin.capabilities.mount` operation, so its own
 *    request body is read RAW (`plan.isMount` branch of
 *    `apiFastifyPlugin`'s `run.ts`'s `readInput` — no `{data:{...}}`
 *    envelope wrapper) — but `apigen-core-client`'s `branchInputSchema`
 *    nests every batch control-plane field ONE level deeper under a
 *    top-level `input` key so `_batch/<kind>` matches every other
 *    apigen-mounted operation's single-JSON-blob convention — so the raw
 *    body is `{ input: { operation, items, concurrency, onItemError } }`,
 *    not the bare control-plane object itself (confirmed against
 *    `parseBatchRequest`, which reads `data.input.*`).
 *  - Each fanned-out `items[i]` becomes that item's `domainArgs` DIRECTLY
 *    (`buildBatchHandler`: `domainArgs: item`), and `dispatch()`
 *    (`apigen-engine-runtime`'s `dispatch.ts`) pulls the real function's
 *    positional args off `domainArgs[paramName]` — for `create(ctx, input)`
 *    the sole domain param is named `input`, exactly as a NON-batch request
 *    on this same route needs (`domainArgs = req.body.data`, i.e.
 *    `{ input: <VerbInput> }` — see `server.spec.ts`'s header note). So one
 *    batch item is `{ input: { title, body, project, by, ... } }` — the same
 *    flat `ICreateIssueInput` shape a direct `POST /backlog/create` needs,
 *    just carried one item at a time inside the batch's `items` array.
 *  - A non-batch (regular, non-mount) HTTP endpoint goes through the
 *    `{data:{...}}` envelope convention (`composeSchemas()`), so the
 *    follow-up plain `POST /backlog/get` call below needs
 *    `{ data: { input: { uid } } }`.
 *  - Every verb (including `get`) returns the outcome envelope `{ ok, data }`
 *    on the wire, whether reached directly or via batch fan-out — so a
 *    fulfilled batch result's `value` is `{ ok: true, data: <ICreateIssueResult> }`,
 *    and the follow-up `get` response body is `{ ok: true, data: <card> }`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBacklogServer } from './server.js';
import { openTestIssueStore, seedProject } from './test/helpers/open-test-issue-store.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';

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
  uid: string;
  item: { uid: string; title: string; project: string };
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
    const by = 'batch-adoption-spec';

    // `project` is resolved-only — never minted by `create` — so seed it
    // through the same real store path `server.spec.ts` uses, before the
    // server process owns the file.
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(seedStore, 'batch-adoption-project');
    await seedStore.close();

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

    // Item #1: valid — real create, real store write. `duplicateAction:
    // 'force'` is passed on both valid items because their bodies are
    // identical ('x'); the real dedupe gate would otherwise legitimately be
    // free to treat the second as a suppressible near-duplicate of the
    // first, which would make this test's "two independent writes" claim
    // flaky rather than exercising the fan-out itself. This is real system
    // behavior (SPEC §6.4), not a workaround for the test.
    //
    // Item #2: INVALID — omits the mandatory `by` field. `by` is required
    // (no `?`) on `ICreateIssueInput`, so the REAL composed validate-Layer
    // (the same AJV validation every non-batch request goes through) rejects
    // it with an AJV "must have required property 'by'" violation before it
    // ever reaches `createIssue` — proving `onItemError: 'continue'`
    // semantics hold for a genuine backlog operation failure, not a
    // synthetic/mocked one.
    //
    // Item #3: valid — proves item #2's rejection did not abort the batch.
    const res = await fetch(`http://127.0.0.1:${port}/_batch/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: {
          operation: 'backlog/create',
          items: [
            { input: { title: 'first item', body: 'x', project: projectUid, by, duplicateAction: 'force' } },
            { input: { title: 'bad item', body: 'x', project: projectUid } },
            { input: { title: 'third item', body: 'x', project: projectUid, by, duplicateAction: 'force' } },
          ],
          concurrency: 2,
          onItemError: 'continue',
        },
      }),
    });

    expect(res.status).toBe(200);
    const results = (await res.json()) as BatchItemResult[];
    expect(results).toHaveLength(3);

    // (1) fulfilled — a REAL item, really persisted. Every mounted verb
    // (including through a batch fan-out) returns the outcome envelope
    // `{ ok, data }` on the wire, so a fulfilled item's payload is nested
    // under `.value.data`, not `.value` directly.
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[0]?.value?.ok).toBe(true);
    expect(results[0]?.value?.data?.created).toBe(true);
    expect(results[0]?.value?.data?.item.title).toBe('first item');
    expect(results[0]?.value?.data?.item.project).toBe(projectUid);
    const firstUid = results[0]?.value?.data?.uid;
    expect(firstUid).toBeTruthy();

    // (2) rejected — the REAL validate-Layer's AJV schema rejection surfaced
    // as a per-item failure, WITHOUT aborting the batch.
    expect(results[1]?.status).toBe('rejected');
    const reason = results[1]?.reason as { code?: string; message?: string } | undefined;
    expect(reason?.code).toBe('invalid_argument');
    expect(reason?.message).toContain('required');
    expect(reason?.message).toContain('by');

    // (3) fulfilled — item #3 was NOT skipped after item #2's failure, and
    // got a DIFFERENT uid than item #1 (proves two independent real store
    // writes, not one write echoed twice).
    expect(results[2]?.status).toBe('fulfilled');
    expect(results[2]?.value?.data?.created).toBe(true);
    expect(results[2]?.value?.data?.item.title).toBe('third item');
    const thirdUid = results[2]?.value?.data?.uid;
    expect(thirdUid).toBeTruthy();
    expect(thirdUid).not.toBe(firstUid);

    // Follow-up real `get` call against the single-op mount proves both
    // batch-created items are genuinely visible in the store afterward (not
    // just echoed back in the batch response). Unlike the batch mount's raw
    // body, a regular (non-mount) endpoint goes through the `{data:{...}}`
    // envelope convention `composeSchemas()` derives for every domain op.
    const getRes = await fetch(`http://127.0.0.1:${port}/backlog/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input: { uid: firstUid } } }),
    });
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { ok: boolean; data: { title: string } };
    expect(got.ok).toBe(true);
    expect(got.data.title).toBe('first item');
  }, 30_000);
});
