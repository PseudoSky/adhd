/**
 * web-ui.spec.ts — proves the backlog web UI prototype works the way a
 * consumer uses it: `nx serve backlog` (tools/run-web-ui.mjs) spawns the
 * REAL built CLI (`dist/index.js serve --transport http`) plus the static +
 * same-origin proxy web server, and the browser-facing seam is
 * `GET http://<web>/` (the UI) + `POST /backlog/*` through the proxy.
 *
 * This test drives that seam end-to-end over real HTTP against an isolated
 * store (ADHD_BACKLOG_DATABASE_PATH → a tmp dir), asserts the consumer-
 * visible outcomes (HTML served; create → query → get round-trip through the
 * proxy), then SIGTERMs the orchestrator and asserts clean shutdown (exit 0,
 * API port refuses connections). Runs by default — spawning local processes
 * and a real HTTP server is setup, not a reason to gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_WEB_UI = join(HERE, '..', 'tools', 'run-web-ui.mjs');
const REPO = 'PseudoSky/web-ui-test';

/**
 * The apigen envelope shape the API returns. Deliberately loose on `data`
 * (each verb's payload differs); the assertions narrow it per verb.
 */
interface ApiEnvelope {
  ok?: boolean;
  code?: string;
  message?: string;
  warnings?: string[];
  data?: {
    created?: boolean;
    humanId?: string;
    title?: string;
    body?: string;
    items?: Array<{ humanId: string }>;
    item?: { humanId: string; title: string; repo: string };
  };
}

/** Bind a server to port 0 and return the chosen free port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('backlog web ui (nx serve backlog seam)', () => {
  let proc: ChildProcess | undefined;
  let apiPort = 0;
  let webPort = 0;
  let storeDir = '';

  beforeAll(async () => {
    [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
    storeDir = mkdtempSync(join(tmpdir(), 'backlog-web-ui-'));
    proc = spawn(process.execPath, [RUN_WEB_UI, '--api-port', String(apiPort), '--web-port', String(webPort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ADHD_BACKLOG_DATABASE_PATH: join(storeDir, 'backlog.db') },
    });
    let bootLog = '';
    proc.stderr?.on('data', (d) => (bootLog += String(d)));
    proc.stdout?.on('data', (d) => (bootLog += String(d)));

    // The consumer seam: the web server answers /. Wait for real HTML.
    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(1500) });
          if (res.ok) return (await res.text()).includes('<title>backlog web ui');
          return false;
        } catch {
          return false;
        }
      },
      45_000,
      'web ui over the proxy (orchestrator + API + web server boot)',
    );
  }, 60_000);

  // NOTE: no afterEach killer here — the orchestrator lives for the whole
  // describe (all read/write tests share it) and only the shutdown test
  // SIGTERMs it. afterEach would kill it after the very first test and make
  // every subsequent test a connection-refused.

  afterAll(() => {
    if (proc && proc.exitCode === null) proc.kill('SIGTERM');
    proc = undefined;
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  });

  function post(path: string, input: unknown): Promise<{ status: number; json: ApiEnvelope }> {
    return fetch(`http://127.0.0.1:${webPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { input } }),
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as ApiEnvelope }));
  }

  it('serves the UI at / (static file, same origin as the API)', async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>backlog web ui');
    // The app's fetch seam is relative (same-origin proxy): every verb is
    // called as `/backlog/<verb>` with the {data:{input}} envelope.
    expect(html).toContain("'/backlog/' + verb");
    expect(html).toContain('{ data: { input } }');
  });

  it('round-trips create → query → get through the proxy against an isolated store', async () => {
    // Fresh isolated store: query is empty.
    const empty = await post('/backlog/query', { view: 'list', filter: { repo: REPO } });
    expect(empty.status).toBe(200);
    expect(empty.json.ok).toBe(true);
    expect(empty.json.data.items).toEqual([]);

    // Create through the proxy.
    const created = await post('/backlog/create', {
      item: { family: 'BUG', title: 'web ui round trip', body: 'created over the proxy', repo: REPO },
      by: 'web-ui.spec:1',
    });
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    expect(created.json.data.created).toBe(true);
    const humanId = created.json.data.humanId as string;
    expect(humanId).toMatch(/^BUG-/);

    // Query sees it.
    const listed = await post('/backlog/query', { view: 'list', filter: { repo: REPO } });
    expect(listed.json.ok).toBe(true);
    expect(listed.json.data?.items?.map((i) => i.humanId)).toContain(humanId);

    // Get returns the full body.
    const got = await post('/backlog/get', { humanId, repo: REPO, fields: ['body'] });
    expect(got.json.ok).toBe(true);
    expect(got.json.data.title).toBe('web ui round trip');
    expect(got.json.data.body).toBe('created over the proxy');
  });

  it('surfaces API failures as proxy responses (not silent dead-ends)', async () => {
    // A malformed input is rejected by the API's validate layer with a 400
    // error envelope — the proxy must pass BOTH the status and the JSON
    // through so the browser can render the message instead of hanging.
    const res = await post('/backlog/query', { view: 'list', bogus: true } as never);
    expect(res.status).toBe(400);
    // validate-layer error envelope: { code, message } with the offending key named.
    expect(res.json.code).toBe('invalid_argument');
    expect(String(res.json.message ?? '')).toContain('must NOT have additional properties');
  });

  it('shuts down cleanly on SIGTERM: orchestrator exits 0 and the API port refuses connections', async () => {
    const p = proc;
    if (!p) throw new Error('orchestrator was not started (beforeAll failed?)');
    const exited = new Promise<number | null>((resolve) => p.on('exit', (code) => resolve(code)));
    p.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<number | null>((_, reject) => setTimeout(() => reject(new Error('orchestrator did not exit after SIGTERM')), 20_000)),
    ]);
    expect(code).toBe(0);

    // Both children were reaped: the API port no longer accepts connections.
    await waitFor(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${apiPort}/_meta/openapi`, { signal: AbortSignal.timeout(1000) });
          return false;
        } catch {
          return true;
        }
      },
      10_000,
      'api port to refuse connections after shutdown',
    );
    proc = undefined;
  });
});
