/**
 * c536ce29 P2 (e2e lane, ADR-0009) — server lifecycle ops logs.
 *
 *   TRC-AC10  `startServer` over the REAL streamable-HTTP transport writes `server.listening` on bind and
 *             `server.shutdown` on close to the ops file; both name the DB path actually opened (a
 *             file-backed store built from the real migrations in an `os.tmpdir()` directory), the
 *             bind host 127.0.0.1, the port, the transport and the pid.
 *
 * Negative control (documented, run during development with a backup-copy restore): removing the
 * `announce(...)` / `announceShutdown()` calls from server.ts turns both tests red.
 * No process is spawned and no third-party network is reached.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HookRegistry } from '@adhd/agent-engine-orchestrator';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStore } from '../store/agent-store.js';
import type { ServerDeps } from '../server.js';
import { makeOpsRig, type IOpsRig } from './ops-e2e-scaffold.js';
import { openDb } from './pricing-fixtures.js';

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Loads a fresh `server.js` under the http transport env (`env.config` is resolved at module load). */
async function loadHttpServer(port: number, transport: 'http' | 'sse' = 'http'): Promise<typeof import('../server.js')> {
  const keys = ['ADHD_AGENT_TRANSPORT', 'ADHD_AGENT_PORT', 'ADHD_AGENT_HOST'] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.ADHD_AGENT_TRANSPORT = transport;
  process.env.ADHD_AGENT_PORT = String(port);
  process.env.ADHD_AGENT_HOST = '127.0.0.1';
  vi.resetModules();
  try {
    return await import('../server.js');
  } finally {
    keys.forEach((k, i) => {
      const v = saved[i];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
}

function fixture(): { deps: ServerDeps; dbFile: string; rig: IOpsRig } {
  const dir = mkdtempSync(join(tmpdir(), 'c536ce29-p2-db-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbFile = join(dir, 'agents.db');
  const o = openDb(dbFile);
  cleanups.push(() => o.sqlite.close());
  const rig = makeOpsRig();
  cleanups.push(() => rig.dispose());
  const hooks = new HookRegistry();
  const deps = {
    agentStore: new AgentStore(o.db, hooks),
    sessionStore: new SessionStore(o.db, hooks),
    taskStore: new TaskStore(o.db),
    hooks,
    db: o.db,
    opsChannel: rig.channels.ops,
  } as unknown as ServerDeps;
  return { deps, dbFile, rig };
}

describe('c536ce29 TRC-AC10 startServer lifecycle ops records', () => {
  it('c536ce29 TRC-AC10: startServer over HTTP writes server.listening, and close writes server.shutdown, naming db path, host, port, transport and pid', async () => {
    const port = await freePort();
    const { startServer } = await loadHttpServer(port);
    const { deps, dbFile, rig } = fixture();

    const started = await startServer(deps);
    let closed = false;
    cleanups.push(async () => {
      if (!closed) await started.close();
    });
    expect(started.httpServer?.listening).toBe(true);

    const before = (await rig.ops()).filter((r) => r.event.startsWith('server.'));
    expect(before.map((r) => r.event)).toEqual(['server.listening']);
    expect(before[0]).toMatchObject({
      component: 'server',
      stream: 'agent-mcp.ops',
      level: 'info',
      pid: process.pid,
      transport: 'http',
      bind_host: '127.0.0.1',
      port,
      db_path: dbFile,
    });

    await started.close();
    closed = true;
    const after = (await rig.ops()).filter((r) => r.event.startsWith('server.'));
    expect(after.map((r) => r.event)).toEqual(['server.listening', 'server.shutdown']);
    expect(after[1]).toMatchObject({ component: 'server',
      stream: 'agent-mcp.ops', pid: process.pid, transport: 'http', db_path: dbFile });
    expect(after[1]?.uptime_ms).toEqual(expect.any(Number));
  });

  it('c536ce29 TRC-AC10: with the ops channel absent from deps the server still starts and closes (inert channels, behaviour unchanged)', async () => {
    const port = await freePort();
    const { startServer } = await loadHttpServer(port);
    const { deps } = fixture();
    delete (deps as { opsChannel?: unknown }).opsChannel;
    const started = await startServer(deps);
    expect(started.httpServer?.listening).toBe(true);
    await started.close();
    expect(started.httpServer?.listening).toBe(false);
  });

  it('c536ce29 FIX-L2: the sse-transport stdio fallback pairs server.listening with server.shutdown', async () => {
    const port = await freePort();
    const { startServer } = await loadHttpServer(port, 'sse');
    const { deps, rig } = fixture();
    const started = await startServer(deps);
    let closed = false;
    cleanups.push(async () => {
      if (!closed) await started.close();
    });
    const before = (await rig.ops()).filter((r) => r.event.startsWith('server.'));
    expect(before.map((r) => r.event)).toEqual(['server.listening']);
    expect(before[0]).toMatchObject({ transport: 'sse' });
    await started.close();
    closed = true;
    const after = (await rig.ops()).filter((r) => r.event.startsWith('server.'));
    expect(after.map((r) => r.event)).toEqual(['server.listening', 'server.shutdown']);
  });
});
