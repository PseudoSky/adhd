/**
 * java-javalin plugin tests — drives a LIVE two-phase-spawn pipeline: a REAL
 * `mvn` subprocess (extraction), a REAL `javac` compile of the codegen-woven
 * dispatcher + user source, and a REAL Javalin instance on an ephemeral
 * (`:0`) port. NOT gated behind an env var — spawning `mvn`/`javac`/`java`
 * is non-hermetic setup, not a reason to skip (AGENTS.md §7 "Live testing is
 * mandatory"): it always drives the plugin's actual `run()` entrypoint (the
 * real consumer path — never a hand-rolled substitute for it), fires real
 * HTTP requests, and asserts real response bytes.
 *
 * Fixture: `packages/apigen/java/src/test/resources/OrderApi.java` (shared
 * with `ApigenJavaExtractorTest` — one canonical fixture, not duplicated)
 * has a `BigDecimal` param/return (`identityDecimal`) and an `Instant`
 * param/return (`identityInstant`) — FEAT-APIGEN-001 acceptance criterion 1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { javaJavalinPlugin, resolveJavaPkgDir } from '../lib/plugin';
import type { RunInput } from '@adhd/apigen-core-client';

const FIXTURE = path.resolve(
  __dirname,
  '../../../java/src/test/resources/OrderApi.java'
);
const NS = 'orders';

interface LiveServer {
  port: number;
  controller: AbortController;
  done: Promise<void>;
}

async function startServer(): Promise<LiveServer> {
  const controller = new AbortController();
  let resolvePort!: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  const input: RunInput = {
    packages: [{ id: NS, schemas: {}, importPath: FIXTURE }],
    outputDir: '/tmp/out',
    options: {
      port: 0,
      host: '127.0.0.1',
      namespace: NS,
      onListening: (p: number) => resolvePort(p),
    },
    signal: controller.signal,
  };

  if (!javaJavalinPlugin.run) {
    throw new Error('javaJavalinPlugin.run is not defined');
  }
  const done = javaJavalinPlugin.run(input);

  // Bounded wait — the plugin itself already bounds waitForReady to 30s;
  // this is a belt-and-suspenders outer bound so a genuinely hung mvn/javac
  // spawn fails the test instead of hanging vitest.
  const port = await Promise.race([
    portPromise,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error('startServer: timed out')), 90_000)
    ),
  ]);

  return { port, controller, done };
}

async function stopServer(server: LiveServer): Promise<void> {
  server.controller.abort();
  await server.done.catch(() => {
    // run() rejects on non-zero exit; SIGTERM-induced exit is expected here.
  });
}

let active: LiveServer | undefined;

afterEach(async () => {
  if (active) {
    await stopServer(active);
    active = undefined;
  }
}, 30_000);

describe('java-javalin plugin — live two-phase-spawn server', () => {
  it('GET /_meta/health returns 200 {"status":"ok","host":"orders"}', async () => {
    active = await startServer();
    const res = await fetch(`http://127.0.0.1:${active.port}/_meta/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', host: 'orders' });
  });

  it('POST /orders/identity-decimal round-trips a BigDecimal byte-identically to canonical wire', async () => {
    active = await startServer();
    const res = await fetch(`http://127.0.0.1:${active.port}/orders/identity-decimal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { x: '123.456' } }),
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    // Canonical decimal wire: a JSON STRING, never a float — DESIGN §3.
    expect(bodyText).toBe('"123.456"');
  });

  it('POST /orders/identity-instant round-trips an Instant byte-identically to canonical wire', async () => {
    active = await startServer();
    const iso = '2024-01-15T12:34:56.789Z';
    const res = await fetch(`http://127.0.0.1:${active.port}/orders/identity-instant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { x: iso } }),
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).toBe(`"${iso}"`);
  });

  it('POST /orders/total-with-tax computes a real BigDecimal result (multi-param dispatch)', async () => {
    active = await startServer();
    const res = await fetch(`http://127.0.0.1:${active.port}/orders/total-with-tax`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { amount: '100.00', taxRate: 0.0 } }),
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    // A real BigDecimal computation — wire is still a decimal STRING, never a float.
    expect(bodyText.startsWith('"')).toBe(true);
    expect(bodyText.endsWith('"')).toBe(true);
    expect(Number(JSON.parse(bodyText))).toBeCloseTo(100.0, 5);
  });

  // ---------------------------------------------------------------------
  // NEGATIVE CONTROL — a genuine structural check, not decorative filler.
  // The canonical decimal wire form is ALWAYS a JSON string, never a bare
  // JSON number (DESIGN §3) — this is the exact regression class a dispatcher
  // glue bug (e.g. falling back to `Double.parseDouble`/numeric
  // serialization instead of the BigDecimal-as-string codec) would produce.
  // `JSON.parse(bodyText)` typing as `'string'` fails the moment that
  // regression is (re)introduced, independent of the specific numeric value
  // under test — unlike an inequality check against an arbitrary wrong
  // literal, this assertion is violated by the actual class of bug it names.
  // ---------------------------------------------------------------------
  it('[TEETH] negative control: decimal wire must be a JSON string, never a bare number', async () => {
    active = await startServer();
    const res = await fetch(`http://127.0.0.1:${active.port}/orders/identity-decimal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { x: '123.456' } }),
    });
    const bodyText = await res.text();
    const parsed = JSON.parse(bodyText);
    // A codec regression to numeric serialization would make this 'number'.
    expect(typeof parsed).toBe('string');
    expect(parsed).toBe('123.456');
  });

  it('unknown operation id is not routed (404 — Javalin default for unmapped path)', async () => {
    active = await startServer();
    const res = await fetch(`http://127.0.0.1:${active.port}/orders/does-not-exist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('resolveJavaPkgDir', () => {
  it('locates the real packages/apigen/java Maven module from this file tree', () => {
    const dir = resolveJavaPkgDir(__dirname);
    expect(fs.existsSync(path.join(dir, 'pom.xml'))).toBe(true);
  });
});
