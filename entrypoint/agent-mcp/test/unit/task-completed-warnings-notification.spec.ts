/**
 * guards: wireTaskNotifications drops the no_tool_use warnings from, or adds an empty warnings key to, the task/completed notification
 * tier: S
 * cites: cbd559eb AC1
 *
 * cbd559eb AC1 (notification leg) — `notifications/task/completed` carries the task's advisory warnings.
 *
 *   cbd559eb AC1  a `done` stream event with `warnings:['no_tool_use']` reaches an MCP client as
 *                 `notifications/task/completed` with `params.warnings` = `['no_tool_use']`.
 *   cbd559eb AC1  a `done` stream event without warnings reaches the client with the `warnings` key
 *                 absent from the notification params.
 *
 * Failure mode (present case): `wireTaskNotifications` (server.ts) drops `warnings` from the `done`
 *   event, so an orchestrator-side warning never reaches the host that dispatched the task.
 * Failure mode (absent case): `wireTaskNotifications` emits a `warnings` key (even undefined or empty)
 *   for a clean completion, changing the notification shape for every task.
 * Tier: S, in-process. The real `startServer` wires the real completion subscriber on the event bus; the
 *   only seam replaced is the stdio transport, by the SDK's in-memory linked pair (`vi.mock` below).
 *   A real MCP `Client` receives the notification across that pair. No process is spawned, no socket
 *   is opened, and nothing waits on a sleep: each await is bounded by a deadline timer.
 * Item: cbd559eb. Criterion: AC1 (notification leg).
 * Red: pending (user hold: tests are not run). Expected at base 21ba12b3, where server.ts never forwards
 *   `warnings`: the present-case test fails on `params.warnings` being `undefined` against
 *   `['no_tool_use']`. The absent-case test passes at base; it is a regression guard, not a red test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HookRegistry } from '@adhd/agent-engine-orchestrator';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStore } from '../../src/store/agent-store.js';
import { noopLogChannel } from '../../src/wire/channels.js';
import type { ServerDeps } from '../../src/server.js';
import { openDb } from '../helpers/pricing-fixtures.js';

/** Bounded wait for a notification. Well under the vitest default timeout, so a miss reports this message. */
const DEADLINE_MS = 2000;

/** The linked pair's server end, handed to the mocked stdio transport. Hoisted so the mock factory can read it. */
const stdioPair = vi.hoisted(() => ({ serverSide: undefined as unknown }));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      return stdioPair.serverSide as object;
    }
  },
}));

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/**
 * Loads a fresh `server.js` with the stdio transport env. `env.config` is resolved at module load, so the
 * transport is pinned explicitly (a developer's global config must not select http) and then restored.
 */
async function loadStdioServer(): Promise<typeof import('../../src/server.js')> {
  const saved = process.env.ADHD_AGENT_TRANSPORT;
  process.env.ADHD_AGENT_TRANSPORT = 'stdio';
  vi.resetModules();
  try {
    return await import('../../src/server.js');
  } finally {
    if (saved === undefined) delete process.env.ADHD_AGENT_TRANSPORT;
    else process.env.ADHD_AGENT_TRANSPORT = saved;
  }
}

/** Deps shaped as the lifecycle fixture: real file-backed stores over the real migrations. */
function fixtureDeps(): ServerDeps {
  const dir = mkdtempSync(join(tmpdir(), 'cbd559eb-ac1-db-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbFile = join(dir, 'agents.db');
  const o = openDb(dbFile);
  cleanups.push(() => o.sqlite.close());
  const hooks = new HookRegistry();
  return {
    agentStore: new AgentStore(o.db, hooks),
    sessionStore: new SessionStore(o.db, hooks),
    taskStore: new TaskStore(o.db),
    hooks,
    db: o.db,
    opsChannel: noopLogChannel,
  } as unknown as ServerDeps;
}

interface IStartedHarness {
  client: Client;
  bus: typeof import('../../src/streaming/event-bus.js');
  /** Resolves with the params of the next `notifications/task/completed` for `taskId`, or rejects at the deadline. */
  nextTaskCompleted: (taskId: string) => Promise<Record<string, unknown>>;
}

/**
 * Starts the real server over the in-memory pair and connects a real MCP client to the other end.
 * The event bus is taken from the same module graph as the server, after `loadStdioServer`, so that
 * `emitTaskEvent` reaches the subscriber `startServer` installed.
 */
async function startHarness(): Promise<{ harness: IStartedHarness; close: () => Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  stdioPair.serverSide = serverSide;

  const { startServer } = await loadStdioServer();
  const started = await startServer(fixtureDeps());

  const client = new Client({ name: 'host', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientSide);

  const bus = await import('../../src/streaming/event-bus.js');

  const nextTaskCompleted = (taskId: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no notifications/task/completed for ${taskId} within ${DEADLINE_MS}ms`)),
        DEADLINE_MS
      );
      client.fallbackNotificationHandler = async (notification) => {
        if (notification.method !== 'notifications/task/completed') return;
        const params = notification.params as Record<string, unknown> | undefined;
        if (params?.task_id !== taskId) return;
        clearTimeout(timer);
        resolve(params);
      };
    });

  return {
    harness: { client, bus, nextTaskCompleted },
    close: async () => {
      await started.close();
      await client.close();
    },
  };
}

describe('cbd559eb AC1 task/completed notification carries advisory warnings', () => {
  it('cbd559eb AC1: a done event with no_tool_use reaches the client as notifications/task/completed with warnings:["no_tool_use"]', async () => {
    const { harness, close } = await startHarness();
    cleanups.push(close);

    // Failure mode: wireTaskNotifications drops `warnings` from the done event.
    const received = harness.nextTaskCompleted('task-warned');
    harness.bus.emitTaskEvent({
      type: 'done',
      taskId: 'task-warned',
      result: 'answer without tools',
      error: null,
      warnings: ['no_tool_use'],
    });
    const params = await received;

    expect(params.status).toBe('completed');
    expect(params.result).toBe('answer without tools');
    expect(params.warnings).toEqual(['no_tool_use']);
  });

  it('cbd559eb AC1: a done event without warnings reaches the client with the warnings key absent from the notification params', async () => {
    const { harness, close } = await startHarness();
    cleanups.push(close);

    // Failure mode: an unconditional `warnings: event.warnings` emits the key for a clean completion.
    // The in-memory pair passes the object by reference (no JSON round-trip), so the key's presence
    // is checked on the own-key list, not by value.
    const received = harness.nextTaskCompleted('task-clean');
    harness.bus.emitTaskEvent({
      type: 'done',
      taskId: 'task-clean',
      result: 'answer with tools',
      error: null,
    });
    const params = await received;

    expect(params.status).toBe('completed');
    expect(Object.keys(params)).not.toContain('warnings');
  });
});
