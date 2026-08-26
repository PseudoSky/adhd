/**
 * server.spec.ts — SPEC.md §7 DoD clause 3 (HTTP variant). Per AGENTS.md
 * "Live testing is mandatory": this default-running (unflagged) test starts
 * the REAL `startBacklogServer({transport:'http'})` against a real temp
 * SQLite file, then issues real `fetch()` HTTP calls — no mocked `fns`, no
 * bypass. Readiness is a bounded poll (never a `sleep` — AGENTS.md §7 rule 3
 * governs concurrency PROOFS; a bounded readiness poll for "has the process
 * finished binding its port yet" is the accepted pattern already used by
 * `entrypoint/apigen-cli`'s own real-consumer e2e tests).
 *
 * INTERFACE_v2 AC-5 consolidation note: this file predates the six-verb
 * (`get`/`query`/`create`/`update`/`relate`/`admin`) mount and asserted the
 * retired v1 routes (`/backlog/get-item`, `/backlog/create-item`) plus a
 * pre-envelope response shape (`created.item.humanId` rather than
 * `body.ok`/`body.data`). Both facts below were established EMPIRICALLY
 * against the real live-mounted server (never assumed from the CLI/MCP
 * shape), by probing `/_meta/openapi`'s live `paths` map and then a real
 * request/response round trip:
 *
 *   - Every mounted verb is a POST, including `get`/`query` — there is no
 *     GET-hoisting for this surface today. The route is
 *     `/backlog/<verbName>` (verb names are already single words, so no
 *     kebab-casing is visible here — see the ORIGINAL comment on the
 *     `get`/`create-item` naming history below, still true for the
 *     namespace/segment mechanism even though the verbs changed).
 *   - The request body is `{ data: { input: <VerbInput> } }` — fastify's
 *     composed-schema wrapper (`data`) around the verb's own single
 *     `input` parameter. A body missing the `data` envelope 400s with
 *     `invalid_argument` and a worked example in the message.
 *   - The response body is the RAW `IOutcomeEnvelope` produced by
 *     `client.ts` — `{ ok: true, data: <payload>, warnings?, meta? }` or
 *     `{ ok: false, error: { code, message, details? } }` — serialized
 *     directly, not unwrapped or reshaped by the fastify mount.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBacklogServer } from './server.js';
import { createItem } from './ops-v1.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';
import type { IOutcomeEnvelope, IBacklogCard, ICreateOutcome } from './model.js';

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

describe('startBacklogServer — live HTTP mount, real fetch, no mocked fns', () => {
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

  it('a real HTTP POST against the v2 `get` verb returns the real outcome envelope matching what createItem wrote', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-http-'));
    const repo = 'PseudoSky/http-test';

    // Seed real data through a real store BEFORE the server owns the file —
    // then close it so the server process (in-thread here, but a real
    // GraphBacklogStore of its own) can open it exclusively.
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = await openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem({ store: seedStore, env: seedEnv }, { family: 'BUG-HTTP', title: 'via http', body: 'x', repo });
    await closeGraphBacklogStore(seedStore);

    const port = await freePort();
    controller = new AbortController();
    serverPromise = startBacklogServer({ transport: 'http', port, host: '127.0.0.1', scope: 'project', cwd: adhdRoot, adhdRoot, signal: controller.signal });

    // Route is `/backlog/get` — the INTERFACE_v2 AC-5 six-verb mount, not
    // the retired v1 `/backlog/get-item`. `apigen-plugin-api-fastify`'s
    // canonical route projection (commit a6e895e2, landed AFTER this
    // package's original commit 1be78422) routes via `project(op).http.route`,
    // which is namespace + path segments, kebab-cased.
    // `extractClientOperations()` (server.ts) extracts with
    // `dropFileSegment: true`, so the `client.d.ts` extraction-artifact
    // segment (`normalizeFileName('client.d.ts')` → `'client-d'`, formerly
    // BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 / BUG-BACKLOG-CANONICAL-
    // NAMING-CLIENT-D-SEGMENT-001) no longer leaks into the route.
    await waitForHttpReady(port, `/_meta/openapi`);

    // Every verb is mounted as POST with a `{ data: { input } }` body —
    // confirmed empirically against the live mount's own OpenAPI doc and a
    // real round trip (see this file's header). `fields:['body']` is
    // requested explicitly because the default card projection omits the
    // body text (INTERFACE_v2 §1 progressive disclosure).
    const res = await fetch(`http://127.0.0.1:${port}/backlog/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input: { humanId: seeded.item.humanId, repo, fields: ['body'] } } }),
    });
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as IOutcomeEnvelope<IBacklogCard>;
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('unreachable — checked above');
    expect(envelope.data.humanId).toBe(seeded.item.humanId);
    expect(envelope.data.title).toBe('via http');
    expect(envelope.data.body).toBe('x');

    // Live-mounted OpenAPI doc route (--use openapiPlugin) proves the mount
    // route composition, not just the domain routes.
    const openapiRes = await fetch(`http://127.0.0.1:${port}/_meta/openapi`);
    expect(openapiRes.status).toBe(200);
  }, 30_000);

  it('POST against the v2 `create` verb over real HTTP actually persists — a follow-up `get` sees it', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-http-post-'));
    const repo = 'PseudoSky/http-post-test';
    const port = await freePort();
    controller = new AbortController();
    serverPromise = startBacklogServer({ transport: 'http', port, host: '127.0.0.1', scope: 'project', cwd: adhdRoot, adhdRoot, signal: controller.signal });

    await waitForHttpReady(port, `/_meta/openapi`);

    // See the route-segment note in the previous test — routes are
    // `/backlog/<verbName>` (`create`, not the retired v1 `create-item`),
    // POST with a `{ data: { input: <CreateInput> } }` body. `by` is
    // mandatory attribution on every mutation (INTERFACE_v2 §7.5,
    // `assertAttribution` in client.ts) — omitting it 400s.
    const createRes = await fetch(`http://127.0.0.1:${port}/backlog/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input: { item: { family: 'BUG-HTTPPOST', title: 'posted', body: 'x', repo }, by: 'http-spec' } } }),
    });
    expect(createRes.status).toBe(200);
    const createEnvelope = (await createRes.json()) as IOutcomeEnvelope<ICreateOutcome>;
    expect(createEnvelope.ok).toBe(true);
    if (!createEnvelope.ok) throw new Error('unreachable — checked above');
    expect(createEnvelope.data.created).toBe(true);
    expect(createEnvelope.data.humanId).toBe('BUG-HTTPPOST-001');
    expect(createEnvelope.data.item?.title).toBe('posted');

    const getRes = await fetch(`http://127.0.0.1:${port}/backlog/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input: { humanId: createEnvelope.data.humanId, repo } } }),
    });
    expect(getRes.status).toBe(200);
    const getEnvelope = (await getRes.json()) as IOutcomeEnvelope<IBacklogCard>;
    expect(getEnvelope.ok).toBe(true);
    if (!getEnvelope.ok) throw new Error('unreachable — checked above');
    expect(getEnvelope.data.title).toBe('posted');
  }, 30_000);
});
