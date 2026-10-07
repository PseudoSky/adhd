/**
 * esc-root-attribution.e2e.test.ts
 *
 * 0d77376f — `enqueueExistingTask` (the restart / DAG-ready re-dispatch path)
 * rebuilt the task's `ExecutionContext` from the persisted row but dropped
 * `rootTaskId` and `callingAgentName`, so a re-dispatched delegation lost its
 * root attribution (`task:start` hook payload, usage-ledger `root_task_id`).
 * The `tasks` table has `parent_task_id` only, so the fix reconstructs the root
 * by walking `parentTaskId` upward (bounded + cycle-safe) and reads
 * `callingAgentName` from the parent row's agent.
 *
 * Every test cites its `0d77376f AC<n>`. The stores, queue, DAG engine and
 * orchestrator are the production code; the ONLY stub is the external LLM
 * (`ScriptedProvider`). The observable is the REAL `task:start` hook payload
 * (the same `rootTaskId` the usage plugin records as `root_task_id`) — never an
 * implementation-shaped spy.
 *
 * Negative control (AC3): reverting the `reconstructDelegationAttribution` spread
 * in `enqueueExistingTask` turns AC1/AC2 RED (rootTaskId/callingAgentName come
 * back undefined). AC4 is guarded by a bounded deadline so a revert of the
 * visited-set/hop cap FAILS instead of hanging.
 *
 * "Restart" here is a real store-stack rebuild: every handle on the first stack
 * is closed and a NEW stack reopens the SAME sqlite file, so the file is the only
 * carried state (the pattern `provider-selection.e2e.test.ts` uses).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { enqueueExistingTask } from '@adhd/agent-engine-orchestrator';
import type { AgentCreateInput } from '@adhd/agent-engine-orchestrator';
import { tasksTable } from '@adhd/agent-store-runtime';

import { ScriptedProvider } from './scripted-provider.js';
import { buildHarness, drainQueue, type Harness } from './harness.js';

interface StartPayload {
  taskId: string;
  rootTaskId?: string;
  callingAgentName?: string;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-root-attr-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function createAgent(h: Harness, label: string): { name: string; sessionId: string } {
  const name = `${label}-${crypto.randomUUID()}`;
  h.agentStore.create({
    name,
    provider: { type: 'openai', model: 'test-model', baseURL: 'http://localhost:1234/v1' },
    systemPrompt: 'You are a test assistant.',
    mcpServers: {},
    permissions: {},
  } as AgentCreateInput);
  const def = h.agentStore.read(name);
  return { name, sessionId: h.sessionStore.create({ agentName: name, agentDefinition: def }).id };
}

/** root -> parent -> child (child left `pending`, i.e. orphaned by a restart). */
function seedChain(h: Harness): {
  rootId: string;
  parentId: string;
  childId: string;
  parentAgent: string;
} {
  const root = createAgent(h, 'root-agent');
  const parent = createAgent(h, 'parent-agent');
  const child = createAgent(h, 'child-agent');
  const rootId = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  h.taskStore.create({ id: rootId, sessionId: root.sessionId, prompt: 'root', recursionDepth: 0 });
  h.taskStore.updateStatus(rootId, 'running');
  h.taskStore.create({
    id: parentId,
    sessionId: parent.sessionId,
    prompt: 'parent',
    parentTaskId: rootId,
    recursionDepth: 1,
  });
  h.taskStore.updateStatus(parentId, 'running');
  h.taskStore.create({
    id: childId,
    sessionId: child.sessionId,
    prompt: 'child',
    parentTaskId: parentId,
    recursionDepth: 2,
  });
  return { rootId, parentId, childId, parentAgent: parent.name };
}

function captureStarts(h: Harness): StartPayload[] {
  const starts: StartPayload[] = [];
  h.hooks.register('task:start', (p) => {
    starts.push({
      taskId: p.executionContext.taskId,
      rootTaskId: p.rootTaskId,
      callingAgentName: p.executionContext.callingAgentName,
    });
  });
  return starts;
}

describe('0d77376f — re-dispatched delegations keep root attribution', () => {
  it('AC1: a delegation re-dispatched after a restart starts with rootTaskId + callingAgentName', async () => {
    const dbPath = path.join(tmp, 'agent-mcp.db');
    const first = await buildHarness({ dbPath, skipOrphanScan: true });
    const ids = seedChain(first);
    first.rawSqlite.pragma('wal_checkpoint(TRUNCATE)');
    first.rawSqlite.close();

    const second = await buildHarness({
      dbPath,
      skipOrphanScan: true,
      defaultProvider: new ScriptedProvider([{ type: 'completed', content: 'ok' }]),
    });
    try {
      const starts = captureStarts(second);
      // The exact call the startup orphan scan makes for a `pending` row.
      await enqueueExistingTask(ids.childId, second.taskDeps);
      await drainQueue(second.queue, 15_000);

      const start = starts.find((s) => s.taskId === ids.childId);
      expect(start, 'the orphaned child was re-dispatched').toBeDefined();
      expect(start?.rootTaskId, '0d77376f AC1 root reconstructed from the parent chain').toBe(
        ids.rootId
      );
      expect(start?.callingAgentName, '0d77376f AC1 calling agent is the parent row agent').toBe(
        ids.parentAgent
      );
      expect(second.taskStore.read(ids.childId).status).toBe('completed');
    } finally {
      await second.teardown();
    }
  }, 60_000);

  it('AC1: a re-dispatched TOP-LEVEL task keeps rootTaskId/callingAgentName undefined', async () => {
    const h = await buildHarness({
      skipOrphanScan: true,
      defaultProvider: new ScriptedProvider([{ type: 'completed', content: 'ok' }]),
    });
    try {
      const a = createAgent(h, 'solo');
      const taskId = crypto.randomUUID();
      h.taskStore.create({ id: taskId, sessionId: a.sessionId, prompt: 'solo' });
      const starts = captureStarts(h);
      await enqueueExistingTask(taskId, h.taskDeps);
      await drainQueue(h.queue, 15_000);
      const start = starts.find((s) => s.taskId === taskId);
      expect(start?.rootTaskId).toBeUndefined();
      expect(start?.callingAgentName).toBeUndefined();
    } finally {
      await h.teardown();
    }
  }, 60_000);

  it('AC2: the DAG-ready dispatch path shows the same attribution', async () => {
    const h = await buildHarness({
      skipOrphanScan: true,
      defaultProvider: new ScriptedProvider([{ type: 'completed', content: 'ok' }]),
    });
    try {
      const ids = seedChain(h);
      // A gated sibling: `waiting` on an upstream, parented at `parent` like a
      // real delegation. It is dispatched ONLY by DagEngine.dispatchReady.
      const gated = createAgent(h, 'gated-agent');
      const upstreamId = crypto.randomUUID();
      const gatedId = crypto.randomUUID();
      h.taskStore.create({ id: upstreamId, sessionId: gated.sessionId, prompt: 'up' });
      h.taskStore.updateStatus(upstreamId, 'completed', { result: 'r' });
      h.taskStore.create({
        id: gatedId,
        sessionId: gated.sessionId,
        prompt: 'gated',
        parentTaskId: ids.parentId,
        recursionDepth: 2,
        dependsOn: [upstreamId],
      });
      expect(h.taskStore.read(gatedId).status).toBe('waiting');

      const starts = captureStarts(h);
      await h.dagEngine.dispatchReady(upstreamId);
      await drainQueue(h.queue, 15_000);

      const start = starts.find((s) => s.taskId === gatedId);
      expect(start, 'DagEngine dispatched the gated task').toBeDefined();
      expect(start?.rootTaskId, '0d77376f AC2').toBe(ids.rootId);
      expect(start?.callingAgentName, '0d77376f AC2').toBe(ids.parentAgent);
    } finally {
      await h.teardown();
    }
  }, 60_000);

  it('AC4: a cyclic parent chain terminates (bounded), no hang', async () => {
    const h = await buildHarness({
      skipOrphanScan: true,
      defaultProvider: new ScriptedProvider([{ type: 'completed', content: 'ok' }]),
    });
    try {
      const ids = seedChain(h);
      // Corrupt the chain into a cycle root -> parent -> root (FKs allow it once
      // both rows exist; only a raw update can close the loop).
      h.db.update(tasksTable).set({ parentTaskId: ids.parentId }).where(eq(tasksTable.id, ids.rootId)).run();

      const starts = captureStarts(h);
      const bounded = Promise.race([
        enqueueExistingTask(ids.childId, h.taskDeps).then(() => 'returned'),
        new Promise<string>((r) => setTimeout(() => r('HUNG'), 10_000)),
      ]);
      expect(await bounded, '0d77376f AC4 the walk must terminate').toBe('returned');
      await drainQueue(h.queue, 15_000);
      const start = starts.find((s) => s.taskId === ids.childId);
      expect(start, 'the task still dispatches').toBeDefined();
      expect([ids.rootId, ids.parentId]).toContain(start?.rootTaskId);
    } finally {
      await h.teardown();
    }
  }, 60_000);
});
