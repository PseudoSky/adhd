import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentRuntimeState, initTelemetry, resolveProcessRole } from '@adhd/sox-telemetry';
import { createPlugin } from '../index.js';
import {
  HookRegistry,
  Orchestrator,
  agentRecords,
  makeCtx,
  makeEnv,
  makeLogDir,
  readRecords,
  runInput,
} from '../test/harness.js';

/**
 * One telemetry provider per process (user-request on backlog 0f760dcd: "make sure it doesn't try
 * to double import the layers"). Real `@adhd/sox-telemetry`, real HookRegistry + Orchestrator;
 * nothing mocked. Cites `0f760dcd AC1` (the plugin loads and traces on a fresh boot) and
 * `0f760dcd AC4` (reuse of the shared telemetry substrate rather than a second provisioning).
 */
let host: ReturnType<typeof makeLogDir>;
let own: ReturnType<typeof makeLogDir>;
beforeEach(() => {
  host = makeLogDir();
  own = makeLogDir();
});
afterEach(() => {
  own.dispose();
  host.dispose();
});

async function runTask(hooks: HookRegistry) {
  const env = makeEnv(hooks);
  await new Orchestrator().run(runInput(env, makeCtx(env), { gate: () => 'allow' }));
}

describe('TracingPlugin reuses an already-initialised telemetry provider (0f760dcd AC1, AC4)', () => {
  it('adopts the host provider: no second initTelemetry, records land in the HOST sink, dispose leaves it open', async () => {
    const hostHandle = initTelemetry({ service: 'host-svc', role: resolveProcessRole('live-service'), logSink: 'file', logDir: host.dir });
    const hostState = currentRuntimeState();

    const hooks = new HookRegistry();
    const plugin = createPlugin({ db: null, config: { service: 'plugin-svc', logDir: own.dir } });
    await plugin.install(hooks);

    expect(plugin.adoptedExistingTelemetry).toBe(true);
    expect(plugin.telemetry).toBeUndefined();
    // Same runtime state object and service: the plugin did not reconfigure the process.
    expect(currentRuntimeState()).toBe(hostState);
    expect(currentRuntimeState().service).toBe('host-svc');

    await runTask(hooks);
    await plugin.dispose();

    const hostRecords = agentRecords(readRecords(hostHandle.currentLogFilePath()));
    expect(hostRecords.some((r) => r.event === 'agent.task.start')).toBe(true);
    expect(hostRecords.some((r) => r.event === 'agent.task.finish')).toBe(true);
    // Nothing was ever provisioned in the plugin's own configured directory.
    expect(plugin.logFilePath()).toBe(hostHandle.currentLogFilePath());
    expect(readdirSync(own.dir)).toEqual([]);
    // dispose() must not have torn down a provider it does not own: the host state is unchanged.
    expect(currentRuntimeState()).toBe(hostState);
    expect(currentRuntimeState().sink).not.toBeNull();
  });

  it('NEGATIVE CONTROL: with no prior provider the plugin owns its own and applies its own config', async () => {
    const hooks = new HookRegistry();
    const plugin = createPlugin({ db: null, config: { service: 'plugin-svc', logDir: own.dir } });
    await plugin.install(hooks);

    expect(plugin.adoptedExistingTelemetry).toBe(false);
    expect(plugin.telemetry).toBeDefined();
    expect(currentRuntimeState().service).toBe('plugin-svc');

    await runTask(hooks);
    expect(agentRecords(readRecords(plugin.telemetry?.currentLogFilePath())).some((r) => r.event === 'agent.task.finish')).toBe(true);
    await plugin.dispose();
  });

  it('a plugin re-installed after its own dispose re-provisions instead of adopting its closed provider', async () => {
    const first = createPlugin({ db: null, config: { service: 'plugin-svc', logDir: own.dir } });
    await first.install(new HookRegistry());
    await first.dispose();

    const hooks = new HookRegistry();
    const second = createPlugin({ db: null, config: { service: 'plugin-svc', logDir: own.dir } });
    await second.install(hooks);
    expect(second.adoptedExistingTelemetry).toBe(false);
    await runTask(hooks);
    expect(agentRecords(readRecords(second.telemetry?.currentLogFilePath())).some((r) => r.event === 'agent.task.finish')).toBe(true);
    await second.dispose();
  });

  it('two plugins in one process share ONE provider (the second adopts the first)', async () => {
    const a = createPlugin({ db: null, config: { service: 'plugin-svc', logDir: own.dir } });
    await a.install(new HookRegistry());
    const stateAfterA = currentRuntimeState();
    const b = createPlugin({ db: null, config: { service: 'other-svc', logDir: host.dir } });
    await b.install(new HookRegistry());
    expect(a.adoptedExistingTelemetry).toBe(false);
    expect(b.adoptedExistingTelemetry).toBe(true);
    expect(currentRuntimeState()).toBe(stateAfterA);
    await b.dispose();
    await a.dispose();
  });
});
