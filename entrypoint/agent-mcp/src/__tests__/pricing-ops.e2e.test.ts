/**
 * c536ce29 P2 (e2e lane, ADR-0009) — pricing ops logs over a REAL loopback socket.
 *
 *   TRC-AC7   a real pull through the real `createPricingService` against an in-process loopback feed
 *             server writes `pricing.pull.start|end|anomaly|retry` to the ops file and the raw feed
 *             exchange to the api file; warn and hold severities and the accept path are visible.
 *             Any non-loopback fetch fails the test loudly (globalThis.fetch is guarded).
 *   TRC-AC18  every ops record carries component, level, event and pid and parses as JSON; secrets
 *             in feed responses never reach either file. Negative control: `identityRedactor` lets the
 *             canary through, so the scan has teeth.
 *
 * No third-party network, no production store: the DB is built from the real migrations in memory and
 * the log roots are an `os.tmpdir()` directory removed in teardown.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { identityRedactor } from '@adhd/agent-plugin-tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPricingService } from '../pricing/service.js';
import { makeOpsRig, type IOpsRig } from './ops-e2e-scaffold.js';
import { bulkFeed, feedOf, makeClock, makeLogger, openDb, type ITestDb } from './pricing-fixtures.js';

/** Built at runtime so the secret scanner never sees a literal. */
const CANARY = ['sk', 'canary', 'p2', 'feed', 'ZQ', '4c81d0e7'].join('-');

let server: http.Server | undefined;
let rig: IOpsRig | undefined;
let db: ITestDb | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  // Fail loudly on anything that is not the loopback feed: no third-party network in this suite.
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = input instanceof URL ? input.href : input;
    const url = new URL(typeof raw === 'string' ? raw : (raw as Request).url);
    if (url.hostname !== '127.0.0.1') throw new Error(`non-loopback fetch refused in test: ${url.href}`);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  db?.sqlite.close();
  db = undefined;
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
  await rig?.dispose();
  rig = undefined;
});

async function serve(bodies: string[]): Promise<string> {
  let n = 0;
  server = http.createServer((_req, res) => {
    const body = bodies[Math.min(n, bodies.length - 1)] as string;
    n += 1;
    res.writeHead(200, { 'content-type': 'application/json', 'x-feed-token': CANARY }).end(body);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/models`;
}

const withCanary = (feed: string): string => JSON.stringify({ ...(JSON.parse(feed) as object), debug_api_key: CANARY });
const base = (held: string, warn: string) => ({
  'held/model': { prompt: held, completion: '0.000002' },
  'warn/model': { prompt: warn, completion: '0.000001' },
  ...bulkFeed(3),
});

function service(url: string, opts: { redactor?: typeof identityRedactor } = {}) {
  rig = makeOpsRig({ knownSecrets: [CANARY], ...opts });
  db = openDb();
  const clock = makeClock();
  const svc = createPricingService({
    db: db.db,
    logger: makeLogger(),
    version: '9.9.9',
    url,
    now: clock.now,
    sleep: async () => undefined,
    baselineModelCount: 0,
    channels: { ops: rig.channels.ops, api: rig.channels.api },
  });
  return { svc, clock };
}

describe('c536ce29 TRC-AC7 pricing pull ops + api records', () => {
  it('c536ce29 TRC-AC7: a real pull writes start/end/anomaly ops records (warn, hold, accept) and the raw feed exchange to the api channel', async () => {
    const url = await serve([
      withCanary(feedOf(base('0.000001', '0.000001'))),
      withCanary(feedOf(base('0.00002', '0.00001'))), // held: 20x, warn: 10x
      withCanary(feedOf(base('0.00002', '0.00001'))), // accept path
    ]);
    const { svc, clock } = service(url);

    const first = await svc.refresh();
    expect(first.status).toBe('ok');
    clock.advance(3_600_000);
    const second = await svc.refresh();
    expect(second.anomalies.map((a) => a.severity).sort()).toEqual(['hold', 'warn']);
    clock.advance(3_600_000);
    const third = await svc.refresh(['held/model']);
    expect(third.status).toBe('ok');

    const ops = (await rig?.ops()) ?? [];
    const pricing = ops.filter((r) => r.event.startsWith('pricing.'));
    const starts = pricing.filter((r) => r.event === 'pricing.pull.start');
    const ends = pricing.filter((r) => r.event === 'pricing.pull.end');
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    expect(starts[0]).toMatchObject({ ledger_id: first.ledgerId, forced: true, url });
    expect(ends[0]).toMatchObject({ ledger_id: first.ledgerId, status: 'ok', http_status: 200, models: first.models, new: first.new, changed: 0, unchanged: 0 });
    expect(ends[1]).toMatchObject({ ledger_id: second.ledgerId, status: 'ok', anomalies: 2, held: 1, warned: 1, unchanged: second.unchanged });

    const anomalies = pricing.filter((r) => r.event === 'pricing.anomaly' && r.ledger_id === second.ledgerId);
    const hold = anomalies.find((r) => r.severity === 'hold');
    const warn = anomalies.find((r) => r.severity === 'warn');
    expect(hold).toMatchObject({ model_id: 'held/model', level: 'error', accepted: false });
    expect(warn).toMatchObject({ model_id: 'warn/model', level: 'warn' });

    expect(starts[2]).toMatchObject({ ledger_id: third.ledgerId, accept: ['held/model'] });
    expect(ends[2]).toMatchObject({ accepted: ['held/model'] });

    const api = (await rig?.api()) ?? [];
    const reqs = api.filter((r) => r.event === 'http.request' && String(r.url).includes('/api/v1/models'));
    const resps = api.filter((r) => r.event === 'http.response');
    expect(reqs).toHaveLength(3);
    expect(reqs[0]).toMatchObject({ method: 'GET' });
    expect(String(reqs[0]?.headers?.['user-agent'] ?? reqs[0]?.headers?.['User-Agent'])).toContain('agent-mcp/9.9.9 (price-sync)');
    expect(resps.length).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => ((await rig?.api()) ?? []).filter((r) => r.event === 'http.response').length).toBe(3);
    const feedBody = ((await rig?.api()) ?? []).find((r) => r.event === 'http.response');
    expect(String(feedBody?.body)).toContain('held/model');
  });

  it('c536ce29 TRC-AC7: a scheduled pull records the rearm delay the scheduler chose', async () => {
    const url = await serve([withCanary(feedOf(base('0.000001', '0.000001')))]);
    const { svc } = service(url);
    svc.start();
    try {
      const ops = (await rig?.ops()) ?? [];
      const rearm = ops.find((r) => r.event === 'pricing.scheduler.rearm');
      expect(rearm).toMatchObject({ why: 'startup_pull_due' });
      expect(typeof rearm?.delay_ms).toBe('number');
    } finally {
      svc.stop();
    }
    const stop = ((await rig?.ops()) ?? []).find((r) => r.event === 'pricing.scheduler.stop');
    expect(stop).toBeDefined();
  });
});

describe('c536ce29 TRC-AC18 ops record shape and secret hygiene', () => {
  it('c536ce29 TRC-AC18: every ops record has component, level, event, pid and parses as JSON; the feed canary never reaches a file', async () => {
    const url = await serve([withCanary(feedOf(base('0.000001', '0.000001'))), `not json ${CANARY}`]);
    const { svc, clock } = service(url);
    await svc.refresh();
    clock.advance(3_600_000);
    const bad = await svc.refresh();
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain(CANARY); // the in-memory result carries it: only the file must not

    const ops = (await rig?.ops()) ?? [];
    expect(ops.length).toBeGreaterThan(0);
    for (const r of ops) {
      expect(r).toMatchObject({ component: expect.any(String), event: expect.any(String), level: expect.any(String), pid: process.pid, stream: 'agent-mcp.ops' });
    }
    expect(ops.some((r) => r.event === 'pricing.pull.end' && r.status === 'failed')).toBe(true);
    expect(ops.filter((r) => r.event.startsWith('pricing.')).every((r) => r.component === 'pricing')).toBe(true);
    const text = (await rig?.text()) ?? '';
    expect(text).not.toContain(CANARY);
  });

  it('c536ce29 TRC-AC18 control: with identityRedactor the same run DOES leak the canary (the scan has teeth)', async () => {
    const url = await serve([withCanary(feedOf(base('0.000001', '0.000001'))), `not json ${CANARY}`]);
    const { svc, clock } = service(url, { redactor: identityRedactor });
    await svc.refresh();
    clock.advance(3_600_000);
    await svc.refresh();
    const text = (await rig?.text()) ?? '';
    expect(text).toContain(CANARY);
    expect(((await rig?.ops()) ?? []).some((r) => JSON.stringify(r).includes(CANARY))).toBe(true);
  });
});
