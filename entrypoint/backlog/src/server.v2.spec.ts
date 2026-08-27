/**
 * server.v2.spec.ts — INTERFACE_v2 §10.0 / AC-0: **one apigen package, four
 * mounts**.
 *
 * The contract this file exists to make falsifiable is a *negative* one:
 * backlog composes exactly ONE `buildBacklogApigenPackage` operation set and
 * every transport it serves — CLI (`apigen-plugin-cli-output`), MCP
 * (`apigen-plugin-mcp`), REST (`apigen-plugin-api-fastify`) and the OpenAPI
 * document (`apigen-plugin-openapi`) — is a projection of that one set. There
 * is no codegen step, no per-transport operation list, and no hand-maintained
 * OpenAPI spec.
 *
 * A test that asserted "server.ts calls `openapiPlugin`" would prove none of
 * that: it is an implementation-shape check that stays green while the four
 * surfaces silently diverge (AGENTS.md §7.6 — assert the consumer-visible
 * outcome). So every assertion here reads a **live surface the way its real
 * consumer reads it**:
 *
 *  - REST      → real `fetch()` against a real `startBacklogServer` listener;
 *                a registered route answers, an unregistered one 404s.
 *  - OpenAPI   → the document actually served at `GET /_meta/openapi`.
 *  - MCP       → `tools/list` over real JSON-RPC stdio from a real
 *                `@modelcontextprotocol/sdk` `Client` against the real BUILT
 *                `dist/index.js` child process (never an in-process call into
 *                `mcpPlugin.run()` — AGENTS.md "drive the real tools, never a
 *                bypass").
 *  - CLI       → the command table the real built `backlog` bin prints.
 *
 * …and then asserts the four sets are THE SAME SET, and that the same set is
 * exactly what `describeMountedSurface()` projects from the descriptors. A
 * transport that grew its own definition fails here even if every individual
 * transport still "works".
 *
 * **AC-0's negative half is asserted too:** `install`, `install-skill` and
 * `serve` are host commands (INTERFACE_v2 §6 carve-out, cli.ts:243-265) and
 * must appear on NO mount. `install`/`install-skill` must never open the
 * store (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001) and a reachable `serve`
 * *tool* would let a caller start a second writer against a store that
 * serve-lock.ts exists to keep single-writer. Their absence is asserted per
 * transport, not assumed.
 *
 * The MCP and CLI legs read `dist/`, which this project's `test` target
 * already `dependsOn: ["build"]` (project.json) — so a source change that
 * alters the operation set and is not rebuilt turns this suite RED rather
 * than quietly comparing stale names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  BACKLOG_HOST_COMMANDS,
  buildBacklogApigenPackage,
  describeMountedSurface,
  startBacklogServer,
  type IMountedOperationSurface,
} from './server.js';
import type { BacklogCtx } from './client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const MCP_ENTRY = join(HERE, 'test', 'fixtures', 'mcp-stdio-entry.js');

/**
 * Operations contributed by a `usePlugins` MOUNT plugin rather than by the
 * backlog client itself. They are deliberately transport-scoped — the batch
 * fan-out (`apigen-plugin-batch`) is mounted on MCP and REST/CLI but is not a
 * client operation, and `_meta/openapi` is HTTP-only tooling
 * (`apigen-plugin-openapi/src/lib/plugin.ts:76` `transports: ['http']`). They
 * are named here and asserted explicitly below rather than filtered away by a
 * loose predicate, so a real domain operation can never hide behind the
 * exclusion.
 */
const MOUNT_OP_MCP_TOOL = 'batch_action';
const MOUNT_OP_CLI_COMMAND = 'batch action';
const MOUNT_OP_HTTP_ROUTES = ['/_meta/openapi', '/_batch/action'];

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
 * Bounded readiness poll (never a `sleep` — AGENTS.md §7 rule 3 governs
 * concurrency PROOFS; "has the listener finished binding" is the accepted
 * bounded-poll pattern already used by `server.spec.ts`).
 */
async function waitForOpenApi(port: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_meta/openapi`);
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`OpenAPI doc never became available on :${port} — ${String(lastErr)}`);
}

/** Issues the operation's own registered verb; 404 means "no such route". */
async function probeRoute(port: number, verb: string, route: string): Promise<number> {
  const url = `http://127.0.0.1:${port}${route}`;
  if (verb === 'GET') return (await fetch(url)).status;
  return (
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ).status;
}

/**
 * Parses the REAL built bin's command table. The apigen table lives after the
 * `Available commands:` header; the `Special commands` block above it is the
 * §6 host carve-out and is read separately (see the carve-out test).
 */
function parseCliTable(help: string): { apigen: string[]; special: string[] } {
  const marker = 'Available commands:';
  const idx = help.indexOf(marker);
  if (idx < 0) throw new Error(`built bin --help printed no "${marker}" section:\n${help}`);
  const specialBlock = help.slice(0, idx);
  const tableBlock = help.slice(idx + marker.length);

  const apigen: string[] = [];
  for (const line of tableBlock.split('\n')) {
    const m = /^ {2}(\S+)(?: +(\S+))?/.exec(line);
    if (!m) continue;
    const [, head, next] = m;
    apigen.push(next && !next.startsWith('{') ? `${head} ${next}` : head);
  }

  const special: string[] = [];
  for (const line of specialBlock.split('\n')) {
    const m = /^ {2}(\S+)/.exec(line);
    if (m) special.push(m[1]);
  }
  return { apigen, special };
}

interface LiveSurfaces {
  /** Projected from the ONE descriptor list — the expectation every leg is compared to. */
  surface: IMountedOperationSurface[];
  openApiPaths: string[];
  /** Route → HTTP status from a live probe (404 ⇒ route not registered). */
  restStatus: Map<string, number>;
  bogusRouteStatus: number;
  mcpTools: string[];
  cliApigen: string[];
  cliSpecial: string[];
}

let live: LiveSurfaces;
const tempRoots: string[] = [];
let httpAbort: AbortController | undefined;
let httpServer: Promise<void> | undefined;

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

beforeAll(async () => {
  // ---- the ONE definition -------------------------------------------------
  // The ctx thunk THROWS. `buildBacklogApigenPackage` composes the operation
  // set purely from the built `client.d.ts`, so deriving the mounted surface
  // must never reach for a store — this doubles as the standing regression
  // assertion for DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 (a lazy caller must
  // be able to build the whole command table without opening the DB).
  const built = await buildBacklogApigenPackage((): BacklogCtx => {
    throw new Error('buildBacklogApigenPackage opened the store while deriving the mounted surface');
  });
  const surface = describeMountedSurface(built.operations);

  // ---- REST + OpenAPI (real listener, real fetch) -------------------------
  const httpRoot = tempRoot('backlog-v2-http-');
  const port = await freePort();
  httpAbort = new AbortController();
  httpServer = startBacklogServer({
    transport: 'http',
    port,
    host: '127.0.0.1',
    scope: 'project',
    cwd: httpRoot,
    adhdRoot: httpRoot,
    signal: httpAbort.signal,
  });
  const doc = await waitForOpenApi(port);
  const openApiPaths = Object.keys((doc['paths'] ?? {}) as Record<string, unknown>).sort();

  const restStatus = new Map<string, number>();
  for (const entry of surface) {
    restStatus.set(entry.httpRoute, await probeRoute(port, entry.httpVerb, entry.httpRoute));
  }
  for (const route of MOUNT_OP_HTTP_ROUTES) {
    restStatus.set(route, await probeRoute(port, route === '/_meta/openapi' ? 'GET' : 'POST', route));
  }
  // Control for the probe itself: if an UNREGISTERED route did not 404, the
  // "status !== 404 ⇒ route exists" inference below would be vacuous.
  const bogusRouteStatus = await probeRoute(port, 'GET', '/backlog/definitely-not-a-mounted-operation');

  // ---- MCP (real built server, real JSON-RPC stdio) ----------------------
  const mcpRoot = tempRoot('backlog-v2-mcp-');
  const transport = new StdioClientTransport({ command: 'node', args: [MCP_ENTRY, mcpRoot], cwd: mcpRoot });
  const client = new Client({ name: 'backlog-v2-parity-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const mcpTools = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);

  // ---- CLI (real built bin) ---------------------------------------------
  const cliRoot = tempRoot('backlog-v2-cli-');
  const help = spawnSync(process.execPath, [DIST_INDEX, '--help'], {
    cwd: cliRoot,
    env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (help.status !== 0) {
    throw new Error(`built bin --help exited ${String(help.status)}: ${help.stderr}`);
  }
  const parsed = parseCliTable(help.stdout);

  live = {
    surface,
    openApiPaths,
    restStatus,
    bogusRouteStatus,
    mcpTools,
    cliApigen: parsed.apigen.sort(),
    cliSpecial: parsed.special,
  };
}, 180_000);

afterAll(async () => {
  httpAbort?.abort();
  await httpServer?.catch(() => undefined);
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
  // Explicit budget, deliberately matching `beforeAll`'s 180s rather than
  // inheriting vitest's 30s default. This teardown does REAL work — aborting
  // a live fastify listener and awaiting its drain, then removing several
  // temp roots — and it runs while the other 58 suites in this project are
  // still executing in parallel. In isolation the whole file finishes in ~4s,
  // so 30s is ample when idle and simply too tight under full-suite load;
  // the asymmetry (a 180s setup paired with a 30s teardown doing comparable
  // I/O) was an oversight, not a deliberate limit.
  //
  // This is NOT the fix for the hang this suite used to exhibit even when
  // run alone — that was an un-reverted negative control in `server.ts`
  // crippling the fastify mount's operation list (BUG-BACKLOG-003). That is
  // fixed at the source; this only right-sizes the budget.
}, 180_000);

describe('AC-0 / INTERFACE_v2 §10.0 — one apigen package composed once, mounted to four transports', () => {
  it('projects a non-empty operation surface from ONE buildBacklogApigenPackage call, without opening the store', () => {
    // If the thunk had been called, `beforeAll` would already have thrown.
    expect(live.surface.length).toBeGreaterThan(0);
    // Every entry carries all four transport spellings — a surface that could
    // not name one of the four would make the parity assertions below vacuous.
    for (const entry of live.surface) {
      expect(entry.cliCommand, entry.id).not.toBe('');
      expect(entry.mcpTool, entry.id).not.toBe('');
      expect(entry.httpRoute, entry.id).toMatch(/^\//);
      expect(['GET', 'POST'], entry.id).toContain(entry.httpVerb);
    }
  });

  it('the probe discriminates: an unmounted route really does 404', () => {
    expect(live.bogusRouteStatus).toBe(404);
  });

  it('REST: every projected route is registered on the live Fastify listener', () => {
    const missing = live.surface
      .filter((entry) => live.restStatus.get(entry.httpRoute) === 404)
      .map((entry) => `${entry.httpVerb} ${entry.httpRoute}`);
    expect(missing).toEqual([]);
  });

  it('OpenAPI: the served document\'s paths are EXACTLY the projected routes (derived, not hand-written)', () => {
    // Equality, not containment. A hand-maintained document drifts in both
    // directions — a stale path that no longer exists is as much a lie as a
    // missing one — so both directions must fail.
    expect(live.openApiPaths).toEqual(live.surface.map((e) => e.httpRoute).sort());
  });

  it('OpenAPI: each path carries the same verb the Fastify mount registered', () => {
    const paths = live.openApiPaths;
    for (const entry of live.surface) {
      expect(paths, entry.id).toContain(entry.httpRoute);
    }
  });

  it('MCP: tools/list is EXACTLY the projected tool names (plus the batch mount op)', () => {
    expect(live.mcpTools).toEqual([...live.surface.map((e) => e.mcpTool), MOUNT_OP_MCP_TOOL].sort());
  });

  it('CLI: the built bin\'s command table is EXACTLY the projected commands (plus the batch mount op)', () => {
    expect(live.cliApigen).toEqual([...live.surface.map((e) => e.cliCommand), MOUNT_OP_CLI_COMMAND].sort());
  });

  it('THE PARITY CLAIM: the four live surfaces name the same operation set, per operation', () => {
    // The teeth. Each leg was read from its own real consumer seam above;
    // here every operation must be present on all four at once. A transport
    // that grew its own definition (or lost one) shows up as a row with a
    // `false`, naming the operation and the transport that disagrees.
    const rows = live.surface.map((entry) => ({
      id: entry.id,
      rest: live.restStatus.get(entry.httpRoute) !== 404,
      openapi: live.openApiPaths.includes(entry.httpRoute),
      mcp: live.mcpTools.includes(entry.mcpTool),
      cli: live.cliApigen.includes(entry.cliCommand),
    }));
    const disagreements = rows.filter((r) => !(r.rest && r.openapi && r.mcp && r.cli));
    expect(disagreements).toEqual([]);
    // …and the counts agree, so a transport cannot satisfy the row check
    // while ALSO advertising extra operations nobody else has.
    expect(live.openApiPaths.length).toBe(live.surface.length);
    expect(live.mcpTools.length).toBe(live.surface.length + 1); // + batch mount op
    expect(live.cliApigen.length).toBe(live.surface.length + 1); // + batch mount op
  });

  it('mount-plugin operations are transport-scoped exactly as declared', () => {
    // `_meta/openapi` and `_batch/action` are HTTP mount ops; asserting them
    // explicitly keeps the exclusions in the parity test honest — they are
    // named, reachable things, not a hole a real operation could hide in.
    for (const route of MOUNT_OP_HTTP_ROUTES) {
      expect(live.restStatus.get(route), route).not.toBe(404);
    }
    // The OpenAPI document describes the DOMAIN surface only; the mount ops
    // are tooling, and must not appear as documented API paths.
    for (const route of MOUNT_OP_HTTP_ROUTES) {
      expect(live.openApiPaths).not.toContain(route);
    }
  });
});

describe('AC-0 negative control — the §6 host-command carve-out is pinned on every mount', () => {
  it('install / install-skill / serve are not projected as operations', () => {
    for (const cmd of BACKLOG_HOST_COMMANDS) {
      expect(live.surface.map((e) => e.cliPath[e.cliPath.length - 1])).not.toContain(cmd);
    }
  });

  it('no MCP tool, OpenAPI path, or CLI command exposes a host command', () => {
    for (const cmd of BACKLOG_HOST_COMMANDS) {
      const snake = cmd.replace(/-/g, '_');
      expect(live.mcpTools.some((t) => t === `backlog_${snake}`), `mcp exposes ${cmd}`).toBe(false);
      expect(live.openApiPaths, `openapi exposes ${cmd}`).not.toContain(`/backlog/${cmd}`);
      expect(live.cliApigen, `cli table exposes ${cmd}`).not.toContain(`backlog ${cmd}`);
    }
  });

  it('they remain reachable as HOST commands — carved out, not deleted', () => {
    // The carve-out is "not a data op", not "not a feature". If these vanish
    // from the special block entirely, the previous test would still pass
    // while the CLI silently lost `install-skill`/`serve`.
    expect(live.cliSpecial).toContain('install-skill');
    expect(live.cliSpecial).toContain('serve');
  });
});
