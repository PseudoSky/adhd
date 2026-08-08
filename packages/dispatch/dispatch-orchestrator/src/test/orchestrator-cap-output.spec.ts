/**
 * orchestrator-cap-output.spec.ts — DEBT-DISPATCH-017: `capOutput()` must
 * never split a multi-byte UTF-8 character at the 8KB guard-output cap.
 *
 * Real components throughout: these tests drive the actual, unmodified
 * `defaultGuardExec` seam (a real `node:child_process.exec` spawn against a
 * real `node -e ...` child process) via `orchestrateCycle` + a real
 * milestone `guard` command — exactly the path `AGENTS.md`'s guard-exec
 * output capping already exercises in `orchestrator.spec.ts`. `capOutput`
 * itself is a private, unexported helper; it is proven here through its one
 * real caller (`defaultGuardExec`), never re-implemented or reached into
 * directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DagJson, MilestoneDag, OperationDag, ProviderConfig } from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { snapshot, optimize } from '@adhd/dispatch-core-optimizer';

import { MockAgentRunner } from './helpers/mock-agent-runner.js';
import { orchestrateCycle, type OrchestratorDeps } from '../lib/orchestrator.js';

// Repo-canonical ephemeral root (CLAUDE.md "Test/ephemeral artifacts"):
// tmp/<package>/<test-scoped>/ — gitignored, fully removed on teardown.
const TMP_ROOT = path.join(
  process.cwd(),
  'tmp',
  'dispatch-orchestrator',
  'orchestrator-cap-output-spec'
);

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const GUARD_OUTPUT_CAP_BYTES = 8 * 1024;
const REPLACEMENT_CHAR = '�';

function makeProviderConfig(): ProviderConfig {
  return {
    type: 'claudecli',
    model_id: 'claude-sonnet-test',
    env_secret: null,
    base_url: null,
    timeout_ms: 30000,
    retry_config: { retries: 0, min_timeout: 0, max_timeout: 0, factor: 1 },
  };
}

function makeMilestone(overrides: Partial<MilestoneDag> = {}): MilestoneDag {
  return {
    description: 'test milestone',
    authored_by: 'test',
    pending: null,
    triggered_by: null,
    phase: 'test',
    depends_on: [],
    agent: null,
    model: null,
    effort: null,
    two_stage: false,
    read_only: [],
    guard: null,
    ...overrides,
  };
}

function makeDag(overrides: Partial<DagJson> = {}): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'greenfield',
    description: 'test plan',
    problem: 'test',
    approach: 'test',
    executor: 'test',
    phases: ['test'],
    terminal: 'a',
    optimization: {
      sentinel_fanout: {
        enabled: false,
        write_multiplier: 1.25,
        read_multiplier: 0.1,
        hit_probability: 0.9,
      },
      b_per_tier: {},
      context_window_per_tier: {},
      context_window_override: null,
      b_override: null,
    },
    providers: { Sonnet: makeProviderConfig() },
    effort_max_tokens: { medium: 4096, high: 8192 },
    milestones: { a: makeMilestone() },
    operations: [] as OperationDag[],
    dispatch_log: [],
    ...overrides,
  };
}

/** A fixed, monotonic (never wall-clock) fake ISO clock for deterministic tests. */
function makeFakeClock(): () => string {
  let n = 0;
  return () => {
    const cur = n++;
    const m = String(Math.floor(cur / 60)).padStart(2, '0');
    const s = String(cur % 60).padStart(2, '0');
    return `2026-01-01T00:${m}:${s}Z`;
  };
}

async function setupScenario(
  name: string,
  dag: DagJson
): Promise<{ dagPath: string; deps: OrchestratorDeps; runner: MockAgentRunner }> {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const dagPath = path.join(dir, 'dag.json');

  const client = createDagClient(createJsonFileSerializer(dagPath));
  await client.saveDag(dag);

  const runner = new MockAgentRunner({ debugDir: path.join(dir, 'mock-debug') });
  // Deliberately NOT overriding `guardExec` — `resolveDeps` falls back to the
  // real, unmodified `defaultGuardExec` (real `node:child_process.exec`
  // spawn), which is the only production caller of `capOutput`.
  const deps: OrchestratorDeps = {
    client,
    optimizer: { snapshot, optimize },
    runner,
    clock: makeFakeClock(),
    idFactory: () => `test-dispatch-${name}`,
    sleep: async () => {
      /* zero-delay — never a real wall-clock wait */
    },
    poll: { intervalMs: 0, timeoutMs: 0 },
  };
  return { dagPath, deps, runner };
}

/**
 * A guard-only milestone (no `agent`) that emits `n` copies of the 3-byte
 * UTF-8 character '☃' (U+2603, bytes `E2 98 83`) to stdout and exits 0.
 * A guard-only milestone still runs a real guard per orchestrator.ts's
 * `shouldRunGuards` handling — no agent dispatch needed to reach `capOutput`.
 */
function snowmanGuard(n: number): string {
  return `node -e "process.stdout.write(String.fromCharCode(9731).repeat(${n}))"`;
}

/** A guard-only milestone that emits `n` ASCII 'a' bytes to stdout and exits 0. */
function asciiGuard(n: number): string {
  return `node -e "process.stdout.write('a'.repeat(${n}))"`;
}

describe('capOutput — UTF-8 boundary safety (DEBT-DISPATCH-017)', () => {
  it('never splits a multi-byte UTF-8 character mid-sequence at the 8KB cap', async () => {
    // 2731 * 3 = 8193 bytes > GUARD_OUTPUT_CAP_BYTES (8192). The naive cut at
    // byte offset 8192 lands squarely inside the 2731st '☃' (bytes 8190-8192
    // are E2 98 83) — proven independently via a raw Buffer probe before
    // this suite was authored.
    const guard = snowmanGuard(2731);
    const { deps } = await setupScenario(
      'utf8-boundary',
      makeDag({ milestones: { a: makeMilestone({ guard }) } })
    );

    const result = await orchestrateCycle(deps);

    const outcome = result.dispatched[0]?.guardOutcomes[0];
    expect(outcome?.milestone).toBe('a');
    expect(outcome?.guardResult).toBe('pass'); // exit 0 — only the cut boundary is under test
    const output = outcome?.guardOutput ?? '';

    // The core assertion: the fix must never leak a UTF-8 replacement
    // character into the truncated output.
    expect(output).not.toContain(REPLACEMENT_CHAR);

    const prefix = output.split('\n...[truncated')[0] ?? '';
    expect(Buffer.byteLength(prefix, 'utf8')).toBeLessThanOrEqual(GUARD_OUTPUT_CAP_BYTES);
    expect(output).toContain(`...[truncated at ${GUARD_OUTPUT_CAP_BYTES} bytes]`);

    // Full-fidelity check: the prefix is exactly whole '☃' characters,
    // i.e. it must divide evenly by 3 bytes/char with no remainder.
    expect(Buffer.byteLength(prefix, 'utf8') % 3).toBe(0);
    expect(prefix).toBe('☃'.repeat(Buffer.byteLength(prefix, 'utf8') / 3));
  });

  it('leaves ASCII-boundary output byte-identical to the pre-fix behavior (no regression)', async () => {
    // 9000 ASCII bytes > GUARD_OUTPUT_CAP_BYTES (8192); byte offset 8192
    // is already a safe cut point for single-byte ASCII, so the fixed
    // `capOutput` must produce the exact same result as the original
    // `buf.toString('utf8', 0, GUARD_OUTPUT_CAP_BYTES)` slice.
    const guard = asciiGuard(9000);
    const { deps } = await setupScenario(
      'ascii-boundary',
      makeDag({ milestones: { a: makeMilestone({ guard }) } })
    );

    const result = await orchestrateCycle(deps);

    const outcome = result.dispatched[0]?.guardOutcomes[0];
    expect(outcome?.guardResult).toBe('pass');
    const output = outcome?.guardOutput ?? '';

    const expectedPrefix = 'a'.repeat(GUARD_OUTPUT_CAP_BYTES);
    const expected = `${expectedPrefix}\n...[truncated at ${GUARD_OUTPUT_CAP_BYTES} bytes]`;
    expect(output).toBe(expected);
    expect(output).not.toContain(REPLACEMENT_CHAR);
  });
});
