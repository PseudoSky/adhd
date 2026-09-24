/**
 * server.e2e.ts — SPEC.md §7 DoD clause 3 (HTTP variant). Per AGENTS.md
 * "Live testing is mandatory": this default-running (unflagged) test starts
 * the REAL `startBacklogServer({transport:'http'})` against a real temp
 * store file, then issues real `fetch()` HTTP calls — no mocked `fns`, no
 * bypass. Readiness is a bounded poll (never a `sleep` — AGENTS.md §7 rule 3
 * governs concurrency PROOFS; a bounded readiness poll for "has the process
 * finished binding its port yet" is the accepted pattern already used by
 * `entrypoint/apigen-cli`'s own real-consumer e2e tests).
 *
 * Route/body shapes below were established EMPIRICALLY against the real
 * live-mounted server (never assumed from the CLI/MCP shape), by probing
 * `/_meta/openapi`'s live `paths` map and then a real request/response round
 * trip, and are cross-checked against `api.surface.spec.ts`'s longhand
 * mounted-surface table:
 *
 *   - Every mounted verb is a POST, including `get`/`query` — there is no
 *     GET-hoisting for this surface. The route is `/backlog/<verbName>`.
 *   - The request body is `{ data: { input: <VerbInput> } }` — fastify's
 *     composed-schema wrapper (`data`) around the verb's own single
 *     `input` parameter. A body missing the `data` envelope 400s with
 *     `invalid_argument` and a worked example in the message.
 *   - The response body is the RAW `IOutcomeEnvelope` produced by
 *     `envelope.ts` — `{ ok: true, data: <payload>, warnings?, meta? }` or
 *     `{ ok: false, error: { code, message, details? } }` — serialized
 *     directly, not unwrapped or reshaped by the fastify mount.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBacklogServer } from './server.js';
import {
  openTestIssueStore,
  seedProject,
} from './test/helpers/open-test-issue-store.js';
import { createIssue } from './write/create-issue.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';
import type { IOutcomeEnvelope } from './envelope.js';
import type { IIssueCard } from './query/types.js';
import type { ICreateIssueResult } from './write/create-issue.js';

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
  throw new Error(
    `server never became ready on port ${port}: ${String(lastErr)}`
  );
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

  it('a real HTTP POST against the `get` verb returns the real outcome envelope matching what createIssue wrote', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-http-'));

    // Seed real data through a real store BEFORE the server owns the file —
    // then close it so the server process (in-thread here, but a real
    // store of its own) can open it exclusively. `resolveBacklogDbPath`
    // resolves the exact same file `startBacklogServer` will open below,
    // given the same `adhdRoot`/scope.
    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(seedStore, 'http-test-project');
    const seeded = await createIssue(seedStore, {
      project: projectUid,
      title: 'via http',
      body: 'x',
      by: 'http-spec-seed',
    });
    await seedStore.close();
    if (!seeded.uid) throw new Error('seed createIssue did not return a uid');
    const seededUid = seeded.uid;

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

    // Route is `/backlog/get` — see this file's header note and
    // `api.surface.spec.ts`'s longhand mounted-surface table.
    await waitForHttpReady(port, `/_meta/openapi`);

    // Every verb is mounted as POST with a `{ data: { input } }` body —
    // confirmed empirically against the live mount's own OpenAPI doc and a
    // real round trip (see this file's header). `fields` REPLACES the
    // default five-field card projection rather than adding to it, so
    // `title`/`body` must both be requested explicitly to assert on them.
    const res = await fetch(`http://127.0.0.1:${port}/backlog/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: { input: { uid: seededUid, fields: ['uid', 'title', 'body'] } },
      }),
    });
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as IOutcomeEnvelope<IIssueCard>;
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('unreachable — checked above');
    expect(envelope.data.uid).toBe(seededUid);
    expect(envelope.data.title).toBe('via http');
    expect(envelope.data.body).toBe('x');

    // Live-mounted OpenAPI doc route (--use openapiPlugin) proves the mount
    // route composition, not just the domain routes.
    const openapiRes = await fetch(`http://127.0.0.1:${port}/_meta/openapi`);
    expect(openapiRes.status).toBe(200);
  }, 30_000);

  it('POST against the `create` verb over real HTTP actually persists — a follow-up `get` sees it', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-http-post-'));

    // The `project` a real `create` call resolves against must already
    // exist (SPEC: `project` is resolved-only, never minted by `create`),
    // so seed it through the same real store path before the server starts.
    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(
      seedStore,
      'http-post-test-project'
    );
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

    // See the route-segment note in the previous test — routes are
    // `/backlog/<verbName>`, POST with a `{ data: { input: <CreateInput> } }`
    // body. `by` is mandatory attribution on every mutation — omitting it
    // 400s.
    const createRes = await fetch(`http://127.0.0.1:${port}/backlog/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: {
          input: {
            title: 'posted',
            body: 'x',
            project: projectUid,
            by: 'http-spec',
          },
        },
      }),
    });
    expect(createRes.status).toBe(200);
    const createEnvelope =
      (await createRes.json()) as IOutcomeEnvelope<ICreateIssueResult>;
    expect(createEnvelope.ok).toBe(true);
    if (!createEnvelope.ok) throw new Error('unreachable — checked above');
    expect(createEnvelope.data.created).toBe(true);
    expect(createEnvelope.data.item?.title).toBe('posted');
    const createdUid = createEnvelope.data.uid;
    expect(createdUid).toBeTruthy();

    const getRes = await fetch(`http://127.0.0.1:${port}/backlog/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input: { uid: createdUid } } }),
    });
    expect(getRes.status).toBe(200);
    const getEnvelope = (await getRes.json()) as IOutcomeEnvelope<IIssueCard>;
    expect(getEnvelope.ok).toBe(true);
    if (!getEnvelope.ok) throw new Error('unreachable — checked above');
    expect(getEnvelope.data.title).toBe('posted');
  }, 30_000);
});
