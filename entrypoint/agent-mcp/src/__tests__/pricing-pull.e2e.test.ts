/**
 * 37f6c511 FS2 (e2e lane, ADR-0009): `runPricePull` over a REAL HTTP socket. An in-process
 * `node:http` fake feed on an ephemeral port serves fixture feeds; the pull uses the platform
 * `fetch`, so request headers, status handling and `Retry-After` are exercised on the wire.
 * Ungated: it needs nothing outside this process. Run with `nx run agent-mcp:e2e`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { PriceHistoryStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { runPricePull } from '../pricing/pull.js';
import { bulkFeed, feedOf, makeClock, makeLogger, openDb, type ITestDb } from './pricing-fixtures.js';

interface ISeen {
  method: string;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server | undefined;
let dbs: ITestDb[] = [];
afterEach(async () => {
  for (const d of dbs) d.sqlite.close();
  dbs = [];
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
});

async function serve(handler: (n: number, res: http.ServerResponse) => void): Promise<{ url: string; seen: ISeen[] }> {
  const seen: ISeen[] = [];
  server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', headers: req.headers });
    handler(seen.length, res);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/models`, seen };
}

function deps(url: string, sleeps: number[] = []) {
  const o = openDb();
  dbs.push(o);
  const clock = makeClock();
  const store = new PriceHistoryStore(o.db);
  return { store, clock, sleeps, base: { store, fetchImpl: fetch, now: clock.now, sleep: async (ms: number) => void sleeps.push(ms), logger: makeLogger(), version: '3.2.1', url, baselineModelCount: 0 } };
}

describe('runPricePull over a real socket', () => {
  it('37f6c511 FS2-AC1/AC13: a real GET stores 0.3 $/M and carries no credential, with the price-sync User-Agent', async () => {
    const body = feedOf({ 'a/one': { prompt: '0.0000003', completion: '0.0000012' }, ...bulkFeed(3) });
    const f = await serve((_n, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(body));
    const d = deps(f.url);
    const r = await runPricePull(d.base);
    expect(r.status).toBe('ok');
    expect(d.store.priceAt('a/one', d.clock.now())?.inputPerM).toBe(0.3);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.method).toBe('GET');
    expect(f.seen[0]?.headers['authorization']).toBeUndefined();
    expect(f.seen[0]?.headers['cookie']).toBeUndefined();
    expect(f.seen[0]?.headers['user-agent']).toBe('agent-mcp/3.2.1 (price-sync)');
  });

  it('37f6c511 FS2-AC11: a real 429 with Retry-After:1 is retried once after 1000 ms and then succeeds', async () => {
    const body = feedOf(bulkFeed(3));
    const f = await serve((n, res) => {
      if (n === 1) res.writeHead(429, { 'retry-after': '1' }).end();
      else res.writeHead(200).end(body);
    });
    const d = deps(f.url);
    expect((await runPricePull(d.base)).status).toBe('ok');
    expect(f.seen).toHaveLength(2);
    expect(d.sleeps).toEqual([1000]);
  });

  it('37f6c511 FS2-AC4: a real HTML 200 body and a dropped connection both end failed with last good prices intact', async () => {
    const ok = feedOf(bulkFeed(3));
    const f = await serve((n, res) => {
      if (n === 1) res.writeHead(200).end(ok);
      else if (n === 2) res.writeHead(200, { 'content-type': 'text/html' }).end('<html>maintenance</html>');
      else res.destroy();
    });
    const d = deps(f.url);
    await runPricePull(d.base);
    d.clock.advance(25 * 3_600_000);
    expect((await runPricePull(d.base)).status).toBe('failed');
    d.clock.advance(25 * 3_600_000);
    expect((await runPricePull(d.base)).status).toBe('failed');
    expect(d.store.history('vendor/m0')).toHaveLength(1);
  });
});
