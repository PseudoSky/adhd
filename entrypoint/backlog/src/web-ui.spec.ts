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
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_WEB_UI = join(HERE, '..', 'tools', 'run-web-ui.mjs');
const PROJECT_NAME = 'web-ui-test-project';

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
    uid?: string;
    title?: string;
    body?: string;
    kind?: string;
    status?: string;
    items?: Array<{ uid: string }>;
    item?: { uid: string; title: string };
    project?: { uid: string; name: string };
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
  let projectUid = '';

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

    // `create` only ever RESOLVES a `project` (SPEC: never mints one), so
    // seed it through the real proxy — the `upsertProject` verb — before any
    // test tries to create against it. This is the same HTTP seam every
    // other assertion in this file drives, not a backdoor into the store.
    const seeded = await post('/backlog/upsert-project', { name: PROJECT_NAME, by: 'web-ui.spec:seed' });
    if (seeded.status !== 200 || !seeded.json.ok) {
      throw new Error(`project seed failed: ${seeded.status} ${JSON.stringify(seeded.json)}`);
    }
    projectUid = seeded.json.data?.project?.uid ?? '';
    if (!projectUid) throw new Error('upsertProject did not return a project uid');
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
    // Fresh isolated store, scoped to the seeded project: query is empty.
    const empty = await post('/backlog/query', { view: 'list', filter: { project: projectUid } });
    expect(empty.status).toBe(200);
    expect(empty.json.ok).toBe(true);
    expect(empty.json.data.items).toEqual([]);

    // Create through the proxy — the real flat `create` shape: no wrapper,
    // no family, no repo. `project` is resolved against the uid seeded in
    // beforeAll (create never mints one).
    const created = await post('/backlog/create', {
      title: 'web ui round trip',
      body: 'created over the proxy',
      project: projectUid,
      by: 'web-ui.spec:1',
    });
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    expect(created.json.data.created).toBe(true);
    const uid = created.json.data.uid as string;
    expect(uid).toBeTruthy();

    // Query sees exactly the uid `create` returned — identity is a single
    // opaque global `uid`, so the teeth here are exact-match, not a pattern.
    const listed = await post('/backlog/query', { view: 'list', filter: { project: projectUid } });
    expect(listed.json.ok).toBe(true);
    expect(listed.json.data?.items?.map((i) => i.uid)).toContain(uid);

    // Get resolves the SAME uid and returns the body that was written.
    const got = await post('/backlog/get', { uid, fields: ['uid', 'title', 'body'] });
    expect(got.json.ok).toBe(true);
    expect(got.json.data.uid).toBe(uid);
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

  /**
   * Loads the REAL served HTML (same GET / a browser gets) into jsdom with
   * `runScripts: 'dangerously'`, so the page's own inline script — its
   * literal `apiCall`/`batchCall`/`createItem`/`saveItem`/`batchSetStatus`/
   * `batchDelete`/`selectItem`/`startEdit` functions — executes for real.
   * `window.fetch` is wired to this process's real `fetch` (resolving
   * relative URLs against the page's own origin, exactly as a browser's
   * `fetch('/backlog/…')` would), so every request that code makes goes out
   * over real HTTP through the real proxy to the real API/store. Only the
   * three CDN <script src> tags are stripped (markdown/chart rendering,
   * irrelevant to payload construction, and pulling live network resources
   * into a test would make it non-hermetic); nothing else about the shipped
   * file is altered.
   *
   * Top-level `const`/`let` bindings (e.g. the page's own `state`) are NOT
   * properties of `window` — that's true in a real browser too, not a jsdom
   * quirk — so these tests never reach into internal state. They only call
   * the page's exposed global FUNCTIONS (real `function` declarations do
   * become `window` properties) and dispatch real DOM events, then observe
   * outcomes either through the rendered DOM or through the real proxy.
   */
  async function loadUiDom(): Promise<InstanceType<typeof JSDOM>> {
    const res = await fetch(`http://127.0.0.1:${webPort}/`);
    const html = await res.text();
    const stripped = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>\s*/g, '');
    const dom = new JSDOM(stripped, {
      runScripts: 'dangerously',
      url: `http://127.0.0.1:${webPort}/`,
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = ((input: string, init?: RequestInit) =>
          fetch(new URL(input, window.location.href).toString(), init)) as typeof fetch;
        window.prompt = () => 'deleted via jsdom-driven web-ui.spec';
        window.confirm = () => true;
      },
    });
    return dom;
  }

  /** Finds the rendered card for `uid` (by its `.id` element's text — the
   *  same lookup a human would do by eye) and dispatches a REAL ctrl-click
   *  DOM event on it, driving the page's own `onclick` handler exactly like
   *  a user's ⌘/Ctrl-click multi-select. */
  function ctrlClickCard(win: Window, uid: string): void {
    const card = [...win.document.querySelectorAll('.card')].find(
      (c) => c.querySelector('.id')?.textContent === uid,
    );
    if (!card) throw new Error(`no rendered card found for uid ${uid}`);
    card.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  }

  it("every verb this UI's own script calls resolves to a real mounted endpoint — no admin, no dead verbs", async () => {
    const htmlRes = await fetch(`http://127.0.0.1:${webPort}/`);
    const html = await htmlRes.text();
    // Derived from the HTML itself, never a hand-maintained duplicate list:
    // every `apiCall('<verb>', …)` and every batch `operation: 'backlog/<verb>'`
    // literally present in the shipped script.
    const calledVerbs = new Set<string>();
    for (const m of html.matchAll(/apiCall\('([a-z-]+)'/g)) calledVerbs.add(m[1]);
    for (const m of html.matchAll(/operation:\s*'backlog\/([a-z-]+)'/g)) calledVerbs.add(m[1]);
    expect(calledVerbs.size).toBeGreaterThan(0);

    const openapiRes = await fetch(`http://127.0.0.1:${apiPort}/_meta/openapi`);
    expect(openapiRes.status).toBe(200);
    const openapi = (await openapiRes.json()) as { paths?: Record<string, unknown> };
    const mountedVerbs = new Set(
      Object.keys(openapi.paths ?? {})
        .map((p) => p.match(/^\/backlog\/([a-z-]+)/)?.[1])
        .filter((v): v is string => Boolean(v)),
    );
    for (const verb of calledVerbs) {
      expect(mountedVerbs.has(verb)).toBe(true);
    }
  });

  it("the create form's real payload-construction logic (createItem()) creates an issue through the proxy", async () => {
    const dom = await loadUiDom();
    const { document, window } = dom.window as unknown as { document: Document; window: Record<string, (...a: unknown[]) => unknown> };
    (document.getElementById('c-project') as HTMLInputElement).value = projectUid;
    (document.getElementById('c-title') as HTMLInputElement).value = 'jsdom-driven create';
    (document.getElementById('c-body') as HTMLTextAreaElement).value = 'built by the real createItem() in index.html';
    (document.getElementById('c-kind') as HTMLInputElement).value = 'bug';
    (document.getElementById('c-by') as HTMLInputElement).value = 'web-ui.spec:jsdom';

    await (window.createItem as () => Promise<unknown>)();

    const hint = document.getElementById('create-hint')?.textContent ?? '';
    expect(hint).toMatch(/^created /);
    const uid = hint.replace('created ', '').trim();
    expect(uid).toBeTruthy();

    const got = await post('/backlog/get', { uid, fields: ['uid', 'title', 'kind'] });
    expect(got.json.ok).toBe(true);
    expect(got.json.data?.title).toBe('jsdom-driven create');
    expect(got.json.data?.kind).toBe('bug');
    dom.window.close();
  });

  it("the edit form's real payload-construction logic (selectItem()+startEdit()+saveItem()) updates+transitions an issue through the proxy, following the minted uid", async () => {
    const dom = await loadUiDom();
    const { document, window } = dom.window as unknown as { document: Document; window: Record<string, (...a: unknown[]) => unknown> };

    // Seed through the real proxy directly (not the UI) so this test is
    // scoped to proving selectItem()/startEdit()/saveItem()'s OWN payload
    // construction, not `create`'s.
    const seeded = await post('/backlog/create', {
      title: 'edit target', body: 'first body', project: projectUid, by: 'web-ui.spec:seed2',
    });
    const seedUid = seeded.json.data?.uid as string;

    // Real click-equivalent: selectItem() is the same function a card click
    // invokes — it performs the real `get` and populates the detail pane +
    // internal `state.lastDetail` that startEdit() reads.
    await (window.selectItem as (uid: string, skip: boolean) => Promise<void>)(seedUid, true);
    expect(document.getElementById('detail')?.textContent).toContain('edit target');

    (window.startEdit as () => void)();
    expect((document.getElementById('c-project') as HTMLInputElement).value).toBe(projectUid);
    (document.getElementById('c-body') as HTMLTextAreaElement).value = 'second body — triggers a supersede';
    (document.getElementById('c-status') as HTMLInputElement).value = 'closed-by-webui-spec';
    (document.getElementById('c-note') as HTMLInputElement).value = 'closed via jsdom-driven saveItem()';
    (document.getElementById('c-by') as HTMLInputElement).value = 'web-ui.spec:jsdom';

    await (window.saveItem as () => Promise<unknown>)();

    // saveItem() re-selects the new item on success — read the new uid off
    // the REAL rendered detail pane, never off internal JS state.
    const idLine = document.querySelector('#detail .id-line')?.textContent ?? '';
    const newUid = idLine.split(' · ')[0]?.trim();
    expect(newUid).toBeTruthy();
    expect(newUid).not.toBe(seedUid);

    // A body change mints a FRESH uid and does NOT invalidate the old row
    // (`t_invalid` stays NULL, §4c), so the seed uid still names a real node.
    // `get` rejects it anyway (SPEC §6.3.1): returning the FROZEN pre-edit
    // snapshot — which is what this path used to do — hands a caller stale
    // content with no signal that the issue moved. Asserted over the REAL
    // HTTP surface, so it covers the wire envelope and not just the resolver.
    const stale = await post('/backlog/get', { uid: seedUid, fields: ['uid', 'body'] });
    expect(stale.json.ok).toBe(false);
    // The error is actionable: it names where the issue actually lives now.
    expect(JSON.stringify(stale.json.error)).toContain(newUid);
    // And it never silently serves the pre-edit body.
    expect(stale.json.data?.body).toBeUndefined();

    const after = await post('/backlog/get', { uid: newUid, fields: ['uid', 'body', 'status'] });
    expect(after.json.ok).toBe(true);
    expect(after.json.data?.body).toBe('second body — triggers a supersede');
    expect(after.json.data?.status).toBe('closed-by-webui-spec');
    dom.window.close();
  });

  it("the batch bar's real payload-construction logic (batchSetStatus()/batchDelete()) drives _batch/action through the proxy", async () => {
    const dom = await loadUiDom();
    const { document, window } = dom.window as unknown as { document: Document; window: Record<string, (...a: unknown[]) => unknown> };

    // Distinct titles/bodies (and duplicateAction:'force') — two near-identical
    // creates back-to-back would otherwise trip the real dedupe gate and the
    // second `create` would return `created:false` with no uid.
    const a = await post('/backlog/create', {
      title: 'batch item alpha', body: 'first distinct batch payload for web-ui.spec', project: projectUid,
      by: 'web-ui.spec:batch', duplicateAction: 'force',
    });
    const b = await post('/backlog/create', {
      title: 'batch item bravo', body: 'second distinct batch payload for web-ui.spec', project: projectUid,
      by: 'web-ui.spec:batch', duplicateAction: 'force',
    });
    const uidA = a.json.data?.uid as string;
    const uidB = b.json.data?.uid as string;

    // loadItems() is the same function `refresh` invokes — renders real
    // cards for the two seeded items (both open, default filter).
    await (window.loadItems as () => Promise<void>)();
    ctrlClickCard(window as unknown as Window, uidA);
    ctrlClickCard(window as unknown as Window, uidB);
    expect(document.getElementById('batch-bar')?.classList.contains('show')).toBe(true);

    (document.getElementById('b-status') as HTMLInputElement).value = 'batch-closed-by-webui-spec';
    (document.getElementById('b-note') as HTMLInputElement).value = 'batch transition via jsdom';
    await (window.batchSetStatus as () => Promise<unknown>)();

    const gotA = await post('/backlog/get', { uid: uidA, fields: ['status'] });
    expect(gotA.json.data?.status).toBe('batch-closed-by-webui-spec');
    const gotB = await post('/backlog/get', { uid: uidB, fields: ['status'] });
    expect(gotB.json.data?.status).toBe('batch-closed-by-webui-spec');

    // batchSetStatus's own runBatch() already cleared the selection and
    // re-rendered the list (the minted status is terminal:false, so both
    // items still satisfy the default 'open' filter) — re-select off that
    // real re-render for the delete pass.
    ctrlClickCard(window as unknown as Window, uidA);
    ctrlClickCard(window as unknown as Window, uidB);
    await (window.batchDelete as () => Promise<unknown>)(); // window.prompt is stubbed to return a reason

    const delA = await post('/backlog/get', { uid: uidA, fields: ['uid'] });
    expect(delA.json.ok).toBe(false);
    const delB = await post('/backlog/get', { uid: uidB, fields: ['uid'] });
    expect(delB.json.ok).toBe(false);
    dom.window.close();
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
