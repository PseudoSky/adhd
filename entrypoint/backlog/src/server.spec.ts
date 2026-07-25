/**
 * server.spec.ts — SPEC.md §7 DoD clause 3 (HTTP variant). Per AGENTS.md
 * "Live testing is mandatory": this default-running (unflagged) test starts
 * the REAL `startBacklogServer({transport:'http'})` against a real temp
 * SQLite file, then issues real `fetch()` HTTP calls — no mocked `fns`, no
 * bypass. Readiness is a bounded poll (never a `sleep` — AGENTS.md §7 rule 3
 * governs concurrency PROOFS; a bounded readiness poll for "has the process
 * finished binding its port yet" is the accepted pattern already used by
 * `entrypoint/apigen-cli`'s own real-consumer e2e tests).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBacklogServer } from './server.js';
import { createItem } from './client.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';

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

  it('a real HTTP GET against getItem returns real JSON matching what createItem wrote', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-http-'));
    const repo = 'PseudoSky/http-test';

    // Seed real data through a real store BEFORE the server owns the file —
    // then close it so the server process (in-thread here, but a real
    // GraphBacklogStore of its own) can open it exclusively.
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem({ store: seedStore, env: seedEnv }, { family: 'BUG-HTTP', title: 'via http', body: 'x', repo });
    closeGraphBacklogStore(seedStore);

    const port = await freePort();
    controller = new AbortController();
    serverPromise = startBacklogServer({ transport: 'http', port, host: '127.0.0.1', scope: 'project', cwd: adhdRoot, adhdRoot, signal: controller.signal });

    // Route is `/backlog/get-item`, NOT `/backlog/getItem` —
    // `apigen-plugin-api-fastify`'s canonical route projection (commit
    // a6e895e2, landed AFTER this package's original commit 1be78422) routes
    // via `project(op).http.route`, which is namespace + path segments,
    // kebab-cased. `extractClientOperations()` (server.ts) extracts with
    // `dropFileSegment: true`, so the `client.d.ts` extraction-artifact
    // segment (`normalizeFileName('client.d.ts')` → `'client-d'`, formerly
    // BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 / BUG-BACKLOG-CANONICAL-
    // NAMING-CLIENT-D-SEGMENT-001) no longer leaks into the route.
    await waitForHttpReady(port, `/backlog/get-item?repo=${encodeURIComponent(repo)}&humanId=${seeded.item.humanId}`);

    const res = await fetch(`http://127.0.0.1:${port}/backlog/get-item?repo=${encodeURIComponent(repo)}&humanId=${seeded.item.humanId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { humanId: string; title: string; body: string };
    expect(body.humanId).toBe(seeded.item.humanId);
    expect(body.title).toBe('via http');
    expect(body.body).toBe('x');

    // Live-mounted OpenAPI doc route (--use openapiPlugin) proves the mount
    // route composition, not just the domain routes.
    const openapiRes = await fetch(`http://127.0.0.1:${port}/_meta/openapi`);
    expect(openapiRes.status).toBe(200);
  }, 30_000);

  it('POST createItem over real HTTP actually persists — a follow-up getItem sees it', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-http-post-'));
    const repo = 'PseudoSky/http-post-test';
    const port = await freePort();
    controller = new AbortController();
    serverPromise = startBacklogServer({ transport: 'http', port, host: '127.0.0.1', scope: 'project', cwd: adhdRoot, adhdRoot, signal: controller.signal });

    await waitForHttpReady(port, `/_meta/openapi`);

    // See the route-segment note in the previous test — routes are
    // `/backlog/<kebab-export-name>`, not `/backlog/<exportName>`.
    const createRes = await fetch(`http://127.0.0.1:${port}/backlog/create-item`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input: { family: 'BUG-HTTPPOST', title: 'posted', body: 'x', repo } } }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { item: { humanId: string } };
    expect(created.item.humanId).toBe('BUG-HTTPPOST-001');

    const getRes = await fetch(`http://127.0.0.1:${port}/backlog/get-item?repo=${encodeURIComponent(repo)}&humanId=${created.item.humanId}`);
    const got = (await getRes.json()) as { title: string };
    expect(got.title).toBe('posted');
  }, 30_000);
});
