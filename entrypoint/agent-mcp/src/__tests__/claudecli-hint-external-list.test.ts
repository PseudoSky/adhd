/**
 * 424b6362 AC7: the claudecli concurrency hint (readOnlyHint on task / tasks_batch / agent) is a
 * bridge-only advertisement. A host (non-claudecli) that talks to the agent-mcp server's own
 * tools/list over real MCP must see NO readOnlyHint (or any annotation) on those tools: the tools
 * create child tasks and are not non-mutating.
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

describe('424b6362 AC7: external tools/list carries no concurrency hint', () => {
  it('424b6362 AC7: task / tasks_batch / agent are listed with no readOnlyHint, and no listed tool is hinted', async () => {
    const o = openDb();
    dbs.push(o);
    const hooks = new HookRegistry();
    const server = createServer({
      agentStore: new AgentStore(o.db, hooks),
      sessionStore: new SessionStore(o.db, hooks),
      taskStore: new TaskStore(o.db),
      hooks,
      db: o.db,
    } as ServerDeps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'non-claudecli-host', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    closers.push(() => client.close(), () => server.close());

    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['task', 'tasks_batch', 'agent']) {
      expect(byName.has(name), `${name} must be listed`).toBe(true);
      expect(byName.get(name)!.annotations?.readOnlyHint, `${name} must not advertise readOnlyHint`).toBeUndefined();
    }
    expect(tools.filter((t) => t.annotations?.readOnlyHint !== undefined).map((t) => t.name)).toEqual([]);
  });
});
