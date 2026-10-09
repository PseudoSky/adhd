/**
 * 37f6c511: `pricing_refresh` / `pricing_history` as a host sees them. A real MCP `Client` talks to
 * the real `createServer` over the SDK's in-memory transport (no socket): the tools must be
 * advertised in `tools/list` and answer `tools/call` with the DB-backed payload.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HookRegistry } from '@adhd/agent-engine-orchestrator';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentStore } from '../store/agent-store.js';

import { createServer, type ServerDeps } from '../server.js';
import { createPricingService } from '../pricing/service.js';
import { bulkFeed, fakeFetch, feedOf, makeClock, makeLogger, openDb, type ITestDb } from './pricing-fixtures.js';

let dbs: ITestDb[] = [];
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  for (const d of dbs) d.sqlite.close();
  dbs = [];
  closers = [];
});

/** Real stores over the migrated DB; the pricing tools never touch them but `createServer` wraps them eagerly. */
async function connect(deps: Partial<ServerDeps>, o: ITestDb = memDb()): Promise<Client> {
  const hooks = new HookRegistry();
  const server = createServer({
    agentStore: new AgentStore(o.db, hooks),
    sessionStore: new SessionStore(o.db, hooks),
    taskStore: new TaskStore(o.db),
    hooks,
    db: o.db,
    ...deps,
  } as ServerDeps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(() => client.close(), () => server.close());
  return client;
}

function memDb(): ITestDb {
  const o = openDb();
  dbs.push(o);
  return o;
}

const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text;

describe('pricing tools over MCP', () => {
  it('37f6c511 FS2-AC10: tools/list advertises pricing_refresh and pricing_history with their schemas and the usage_query fields', async () => {
    const client = await connect({});
    const tools = (await client.listTools()).tools;
    const refresh = tools.find((t) => t.name === 'pricing_refresh');
    const history = tools.find((t) => t.name === 'pricing_history');
    expect(refresh?.inputSchema.properties).toHaveProperty('accept');
    expect(history?.inputSchema.properties).toHaveProperty('model');
    expect(history?.inputSchema.required).toEqual(['model']);
    const usage = tools.find((t) => t.name === 'usage_query');
    expect(usage?.description).toContain('response_model');
    expect(usage?.description).toContain('unpriced_models');
  });

  it('37f6c511 FS2-AC10 / FS5-AC2: tools/call pricing_refresh pulls through the real service and pricing_history returns what it wrote', async () => {
    const o = memDb();
    const clock = makeClock();
    const fetched = fakeFetch({ body: feedOf({ 'x/y': { prompt: '0.0000003', completion: '0.0000012' }, ...bulkFeed(2) }) });
    const pricing = createPricingService({ db: o.db, logger: makeLogger(), version: '1.0.0', fetchImpl: fetched.fetchImpl, now: clock.now, sleep: async () => undefined, baselineModelCount: 0 });
    const client = await connect({ pricing }, o);

    const refreshed = JSON.parse(text(await client.callTool({ name: 'pricing_refresh', arguments: {} })));
    expect(refreshed).toMatchObject({ status: 'ok', models: 3, new: 3, changed: 0, unchanged: 0 });

    const history = JSON.parse(text(await client.callTool({ name: 'pricing_history', arguments: { model: 'x/y' } })));
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({ input_per_m: 0.3, output_per_m: 1.2, source: 'openrouter-live', ledger_id: refreshed.ledger_id });
    expect(history.status.last_ok.ledger_id).toBe(refreshed.ledger_id);
  });

  it('37f6c511 FS2-AC19: invalid input and a server without pricing wiring return an MCP error, not a crash', async () => {
    const o = memDb();
    const withPricing = await connect({ pricing: createPricingService({ db: o.db, logger: makeLogger(), version: '1.0.0' }) }, o);
    const bad = await withPricing.callTool({ name: 'pricing_history', arguments: { model: 'a/b', from: 'not-a-date' } });
    expect(bad.isError).toBe(true);
    const bare = await connect({});
    const none = await bare.callTool({ name: 'pricing_history', arguments: { model: 'a/b' } });
    expect(none.isError).toBe(true);
    expect(text(none)).toContain('not available');
  });
});
