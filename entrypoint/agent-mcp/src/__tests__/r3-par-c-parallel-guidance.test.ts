import { createHash } from 'node:crypto';
/**
 * 0d0004b8 (R3-PAR-C) AC1: the advertised `task` / `tasks_batch` descriptions steer a model toward
 * parallel dispatch, and the input-schema hash of each tool is unchanged (schema bytes are part of the
 * cached tool prefix, so the guidance must live in the description only). Driven as a host does: a real
 * MCP `Client` over the real `createServer` via the SDK in-memory transport.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HookRegistry } from '@adhd/agent-engine-orchestrator';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentStore } from '../store/agent-store.js';

import { createServer, type ServerDeps } from '../server.js';
import { openDb, type ITestDb } from './pricing-fixtures.js';

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

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** sha256 of JSON.stringify(inputSchema) captured BEFORE the description change; must never move with wording. */
const SCHEMA_SHA: Record<string, string> = { task: 'c90d23be2f9a1cc862c35219c9203727fa241af98159b485999e2f966dbd1569', tasks_batch: '84290017888a6cbbbb21d3cd329bc86ec14690e2d037a3a55fdc4c2ae99e2008' };

describe('0d0004b8 R3-PAR-C parallel-dispatch guidance', () => {
  it('0d0004b8 AC1: task and tasks_batch descriptions carry the parallel guidance and the input-schema hashes are unchanged', async () => {
    const client = await connect({});
    const tools = (await client.listTools()).tools;
    const task = tools.find((t) => t.name === 'task');
    const batch = tools.find((t) => t.name === 'tasks_batch');
    expect(task?.description).toMatch(/independent[^.]*ONE turn/i);
    expect(task?.description).toContain('tasks_batch');
    expect(batch?.description).toMatch(/independent[^.]*ONE turn/i);
    expect(batch?.description).toMatch(/list of prompts/i);
    expect(sha(task?.inputSchema)).toBe(SCHEMA_SHA.task);
    expect(sha(batch?.inputSchema)).toBe(SCHEMA_SHA.tasks_batch);
  });
});
