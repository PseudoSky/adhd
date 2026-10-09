import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSelection } from '@adhd/agent-base-types';
import { createProvider } from '@adhd/agent-engine-orchestrator';
import type { EngineConfig } from '@adhd/agent-engine-orchestrator';
import { createPlugin } from '../index.js';
import type { TracingPlugin } from '../index.js';
import {
  HookRegistry,
  Orchestrator,
  eventSeen,
  makeCtx,
  makeEnv,
  makeLogDir,
  readRecords,
  runInput,
  spanCounts,
  withDeadline,
  engineConfig,
} from '../test/harness.js';
import type { Recorded } from '../test/harness.js';

/**
 * c536ce29 W4 — model-call completeness. Real: HookRegistry, the real Orchestrator.run(), real
 * stores, the real createProvider() + OpenAIProvider, the real tracing plugin and a real
 * @adhd/sox-telemetry JSONL sink. Mocked: ONLY the external boundary — the `openai` SDK's network
 * call (no sockets, no timers).
 */

/**
 * The external boundary: a loopback HTTP server standing in for the model API (127.0.0.1, ephemeral
 * port; never a third-party host). The real `openai` SDK talks to it.
 */
const fake = { status: 200, body: {} as unknown, server: undefined as Server | undefined, url: '' };
beforeAll(async () => {
  fake.server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(fake.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fake.body));
    });
  });
  await new Promise<void>((resolve) => fake.server?.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(fake.server?.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => fake.server?.close(() => resolve()));
});

let log: ReturnType<typeof makeLogDir>;
beforeEach(() => {
  log = makeLogDir();
});
afterEach(() => log.dispose());

const SELECTION: ProviderSelection = { providerType: 'openai', modelRef: 'gpt-4o-mini' } as ProviderSelection;

function providerEngineConfig(): EngineConfig {
  return {
    ...engineConfig(),
    getProviderConfig: () => ({ secret: 'sk-' + 'unit'.repeat(3), model: 'gpt-4o-mini', baseURL: fake.url }),
  } as EngineConfig;
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const setBilling = (): void => {
  fake.status = 402;
  fake.body = { error: { message: 'Insufficient credits', type: 'insufficient_quota', code: 'insufficient_quota' } };
};
const setOk = (): void => {
  fake.status = 200;
  fake.body = okResponse;
};

const okResponse = {
  model: 'gpt-4o-mini',
  choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
};

async function installed() {
  const hooks = new HookRegistry();
  const plugin = createPlugin({ db: null, config: { service: 'w4', logDir: log.dir } });
  await plugin.install(hooks);
  return { hooks, plugin };
}
const records = (plugin: TracingPlugin): Recorded[] => readRecords(plugin.telemetry?.currentLogFilePath());

async function closeSession(hooks: HookRegistry, env: ReturnType<typeof makeEnv>): Promise<void> {
  const closed = eventSeen(hooks, 'session:closed');
  env.sessionStore.close(env.sessionId);
  await withDeadline(closed, 'session:closed');
}

async function runThroughFactory(hooks: HookRegistry, o: { wrap: boolean }) {
  const env = makeEnv(hooks);
  const ctx = makeCtx(env);
  const provider = createProvider(
    SELECTION,
    {},
    providerEngineConfig(),
    logger,
    o.wrap ? { hooks, executionContext: ctx } : undefined
  );
  const outcome = await new Orchestrator().run(runInput(env, ctx, { provider })).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await closeSession(hooks, env);
  return { env, ctx, outcome };
}

describe('c536ce29 TRC-AC25 — every model call is traced through the real factory + orchestrator', () => {
  it('c536ce29 TRC-AC25: a failing (402) model call emits provider:failed and closes with model_call.error, never left open', async () => {
    const { hooks, plugin } = await installed();
    const failures: unknown[] = [];
    hooks.register('provider:failed', ((p: unknown) => void failures.push(p)) as never);
    setBilling();

    const { outcome } = await runThroughFactory(hooks, { wrap: true });

    expect(outcome.ok).toBe(false);
    expect(failures).toHaveLength(1);
    const failure = failures[0] as { disposition: string; failure: { class: string; status?: number } };
    expect(failure.disposition).toBe('terminal');
    expect(failure.failure.class).toBe('billing');
    expect(failure.failure.status).toBe(402);

    const recs = records(plugin);
    expect(spanCounts(recs, 'agent.model_call')).toEqual({ start: 1, finish: 0, error: 1 });
    expect(recs.filter((r) => r['agent.outcome'] === 'unclosed')).toEqual([]);
    await plugin.dispose();
  });

  it('c536ce29 TRC-AC25: a successful model call records start and finish and emits no provider:failed', async () => {
    const { hooks, plugin } = await installed();
    const failures: unknown[] = [];
    hooks.register('provider:failed', ((p: unknown) => void failures.push(p)) as never);
    setOk();

    const { outcome } = await runThroughFactory(hooks, { wrap: true });

    expect(outcome.ok).toBe(true);
    expect(failures).toEqual([]);
    expect(spanCounts(records(plugin), 'agent.model_call')).toEqual({ start: 1, finish: 1, error: 0 });
    await plugin.dispose();
  });

  it('c536ce29 TRC-AC25: without hooks the factory returns the bare provider, so no provider:failed is emitted (control for the decorator)', async () => {
    const { hooks, plugin } = await installed();
    const failures: unknown[] = [];
    hooks.register('provider:failed', ((p: unknown) => void failures.push(p)) as never);
    setBilling();

    await runThroughFactory(hooks, { wrap: false });

    expect(failures).toEqual([]);
    expect(spanCounts(records(plugin), 'agent.model_call').error).toBe(0);
    await plugin.dispose();
  });
});

describe('c536ce29 TRC-AC26 — provider-failure and budget events map to records', () => {
  it('c536ce29 TRC-AC26: attempt_failed / tripped / recovered each produce a record (tripped/recovered need no task)', async () => {
    const { hooks, plugin } = await installed();
    const env = makeEnv(hooks);
    const ctx = makeCtx(env);
    const failure = {
      v: 1, class: 'billing', scope: 'credential', retryable: false, resumable: true, confidence: 'certain',
      providerType: 'openai', modelRef: 'm', wireModel: 'm', credentialKey: 'k', credentialScope: 'k',
      message: 'x', source: 'http', attempts: [], hops: [], classifierVersion: 1, status: 402,
    };
    const trip = { key: 'openai|k', generation: 1, recheckAt: new Date().toISOString(), state: 'open' };
    const base = { domain: 'provider', failure, correlationId: ctx.taskId, at: new Date().toISOString() };
    await hooks.emit('provider:attempt_failed', { ...base, executionContext: ctx, attempt: 1, disposition: 'retrying' } as never);
    await hooks.emit('provider:tripped', { ...base, trip } as never);
    await hooks.emit('provider:recovered', { ...base, trip, reason: 'probe_ok' } as never);
    await closeSession(hooks, env);

    const recs = records(plugin);
    for (const name of ['agent.provider.attempt_failed', 'agent.provider.tripped', 'agent.provider.recovered']) {
      expect(spanCounts(recs, name).finish, name).toBe(1);
    }
    expect(recs.find((r) => r.event === 'agent.provider.tripped.finish')?.['agent.provider.trip_key']).toBe('openai|k');
    await plugin.dispose();
  });

  it('c536ce29 TRC-AC26: budget:warning is a record; budget:block is a record AND closes the open model call as an error', async () => {
    const { hooks, plugin } = await installed();
    const env = makeEnv(hooks);
    const ctx = makeCtx(env);
    const payload = { executionContext: ctx, field: 'costUsd', maximum: 1, current: 2, message: 'over' };
    await hooks.emit('task:start', { executionContext: ctx } as never);
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] } as never);
    await hooks.emit('budget:warning', payload as never);
    expect(spanCounts(records(plugin), 'agent.model_call')).toEqual({ start: 1, finish: 0, error: 0 });
    await hooks.emit('budget:block', payload as never);
    await hooks.emit('task:failed', { executionContext: ctx, error: 'BUDGET_EXCEEDED' } as never);
    await closeSession(hooks, env);

    const recs = records(plugin);
    expect(spanCounts(recs, 'agent.budget.warning').finish).toBe(1);
    expect(spanCounts(recs, 'agent.budget.block').finish).toBe(1);
    expect(spanCounts(recs, 'agent.model_call')).toEqual({ start: 1, finish: 0, error: 1 });
    expect(recs.filter((r) => r['agent.outcome'] === 'unclosed')).toEqual([]);
    await plugin.dispose();
  });
});
