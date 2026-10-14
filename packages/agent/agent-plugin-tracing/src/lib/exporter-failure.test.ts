import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Mode = 'ok' | 'throws-sync' | 'rejects' | 'snapshot-rejects';
const state: { mode: Mode } = { mode: 'ok' };

// The telemetry substrate is the external boundary here: wrap the REAL implementation and make it
// misbehave on demand. Everything else — the plugin, HookRegistry, Orchestrator, stores — is real.
vi.mock('@adhd/sox-telemetry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@adhd/sox-telemetry')>();
  return {
    ...real,
    withSpan: ((name: string, attrs: never, fn: never) => {
      if (state.mode === 'throws-sync') throw new Error('exporter exploded (sync)');
      if (state.mode === 'rejects') return Promise.reject(new Error('exporter exploded (async)'));
      return real.withSpan(name, attrs, fn);
    }) as typeof real.withSpan,
    snapshotMetrics: ((reason: never) => {
      if (state.mode === 'snapshot-rejects') return Promise.reject(new Error('snapshot exploded'));
      return real.snapshotMetrics(reason);
    }) as typeof real.snapshotMetrics,
  };
});

import { createPlugin } from '../index.js';
import { HookRegistry, Orchestrator, makeCtx, makeEnv, makeLogDir, runInput } from '../test/harness.js';
import { runParentDispatch, startFakeOpenAI } from '../test/dispatch-harness.js';

/**
 * A failing exporter must never break a task (spec: observational only). Each mode makes the
 * substrate fail at a different seam; the task must still return its real result, with no
 * unhandled rejection (vitest fails the run on one).
 */
let log: ReturnType<typeof makeLogDir>;
beforeEach(() => {
  log = makeLogDir();
  state.mode = 'ok';
});
afterEach(() => {
  state.mode = 'ok';
  log.dispose();
});

async function runTaskWith(mode: Mode): Promise<{ result: string; executed: string[] }> {
  const hooks = new HookRegistry();
  const plugin = createPlugin({ db: null, config: { service: 'exporter-failure', logDir: log.dir } });
  await plugin.install(hooks);
  state.mode = mode;
  const env = makeEnv(hooks);
  const executed: string[] = [];
  const { result } = await new Orchestrator().run(runInput(env, makeCtx(env), { gate: () => 'allow', executed }));
  env.sessionStore.close(env.sessionId);
  await new Promise<void>((r) => setImmediate(r));
  plugin.dispose();
  return { result, executed };
}

describe('a throwing exporter never breaks a task', () => {
  for (const mode of ['throws-sync', 'rejects', 'snapshot-rejects'] as const) {
    it(`withSpan/snapshot failure mode "${mode}": the task still completes and the tool still runs`, async () => {
      const { result, executed } = await runTaskWith(mode);
      expect(result).toBe('finished');
      expect(executed).toEqual(['agent-mcp__task']);
    });
  }

  it('an unwritable sink (logDir is a regular file) does not prevent install or break the task', async () => {
    const blocker = mkdtempSync(join(tmpdir(), 'agent-tracing-blocker-'));
    const asFile = join(blocker, 'not-a-dir');
    writeFileSync(asFile, 'x');
    try {
      const hooks = new HookRegistry();
      const plugin = createPlugin({ db: null, config: { service: 'unwritable', logDir: asFile } });
      await plugin.install(hooks);
      const env = makeEnv(hooks);
      const { result } = await new Orchestrator().run(runInput(env, makeCtx(env), { gate: () => 'allow' }));
      expect(result).toBe('finished');
      plugin.dispose();
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });

  // R10 S5 AC2: the new dispatch / startup / tool-signal paths are observational too.
  for (const mode of ['throws-sync', 'rejects'] as const) {
    it(`R10 S5 AC2: a real parent -> worker dispatch completes with its real result while the exporter fails ("${mode}")`, async () => {
      const openai = await startFakeOpenAI(() => ({ content: 'worker answer' }));
      try {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: null, config: { service: 'exporter-failure', logDir: log.dir } });
        await plugin.install(hooks);
        state.mode = mode;
        const run = await runParentDispatch(hooks, openai.baseURL, 'task', { agent_name: 'worker-agent', prompt: 'p' });
        expect(run.toolErrors).toEqual([]);
        expect(run.result).toBe('parent finished');
        expect(run.toolResults).toHaveLength(1);
        expect(run.toolResults[0]).toMatchObject({ status: 'completed', result: 'worker answer' });
        await plugin.dispose();
      } finally {
        state.mode = 'ok';
        await openai.close();
      }
    });
  }

  it('R10 S5 AC2: a throwing hook handler on the new dispatch event never fails the dispatch', async () => {
    const openai = await startFakeOpenAI(() => ({ content: 'worker answer' }));
    try {
      const hooks = new HookRegistry();
      hooks.register('dispatch:completed', () => {
        throw new Error('observer exploded');
      });
      const run = await runParentDispatch(hooks, openai.baseURL, 'task', { agent_name: 'worker-agent', prompt: 'p' });
      expect(run.toolErrors).toEqual([]);
      expect(run.toolResults[0]).toMatchObject({ status: 'completed', result: 'worker answer' });
    } finally {
      await openai.close();
    }
  });

  it('negative control: the same task with a healthy exporter DOES write spans (the mode flag is what matters)', async () => {
    const hooks = new HookRegistry();
    const plugin = createPlugin({ db: null, config: { service: 'exporter-failure', logDir: log.dir } });
    await plugin.install(hooks);
    const env = makeEnv(hooks);
    await new Orchestrator().run(runInput(env, makeCtx(env), { gate: () => 'allow' }));
    const { readRecords, spanCounts } = await import('../test/harness.js');
    expect(spanCounts(readRecords(plugin.telemetry?.currentLogFilePath()), 'agent.task')).toEqual({
      start: 1,
      finish: 1,
      error: 0,
    });
    plugin.dispose();
  });
});
