/**
 * core.spec.ts — integration tests for dispatch-cli's DI'd core, driven
 * through REAL components: real dag.json files under `tmp/dispatch-cli/`
 * written via `createJsonFileSerializer`/`createDagClient`, real
 * `@adhd/dispatch-core-optimizer` `snapshot()`/`optimize()` (transitively, inside
 * `core.ts`), real `@adhd/dispatch-orchestrator` `orchestrateCycle()`. The
 * only test double anywhere in this file is `MockAgentRunner` — the
 * documented external boundary (a real agent-mcp dispatch is a paid
 * third-party model call; see `calibrateCore`/`runCycleCore`'s own doc
 * comments in `../lib/core.ts`).
 *
 * Every assertion targets a CONSUMER-VISIBLE outcome: the literal value a
 * CLI caller would see as JSON, or what a FRESH client re-reads from disk —
 * never internal call counts alone. No test ever writes to the real home
 * directory or constructs `buildProductionAgentMcpRunner()`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { MockAgentRunner } from '@adhd/dispatch-orchestrator';
import type { DagJson } from '@adhd/dispatch-base-spec';

import {
  assertModelTier,
  buildClient,
  calibrateCore,
  DEFAULT_RUN_DEBUG_DIR,
  eligibleCore,
  optimizeCore,
  runCycleCore,
  snapshotCore,
  statusCore,
  validateCore,
} from '../lib/core.js';
import { makeCompletionLogEntry, makeFixtureDag } from './helpers/fixtures.js';

// Repo-canonical ephemeral root (CLAUDE.md "Test/ephemeral artifacts"):
// tmp/<package>/<test-scoped>/ — gitignored, fully removed on teardown.
const TMP_ROOT = path.join(process.cwd(), 'tmp', 'dispatch-cli', 'core-spec');

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  // runCycleCore's no-override default path writes outside TMP_ROOT by
  // design (dispatch-cli's own stable tmp namespace, not a per-test one) —
  // swept here too so this file leaves zero residue overall.
  fs.rmSync(DEFAULT_RUN_DEBUG_DIR, { recursive: true, force: true });
});

let caseN = 0;
/** Writes `dag` to a fresh, isolated dag.json under TMP_ROOT and returns its path. */
async function writeFixture(dag: DagJson): Promise<string> {
  const dir = path.join(TMP_ROOT, `case-${caseN++}`);
  fs.mkdirSync(dir, { recursive: true });
  const dagPath = path.join(dir, 'dag.json');
  await createDagClient(createJsonFileSerializer(dagPath)).saveDag(dag);
  return dagPath;
}

// ---------------------------------------------------------------------------
// validateCore
// ---------------------------------------------------------------------------

describe('validateCore', () => {
  it('a structurally-valid dag.json validates clean', async () => {
    const dagPath = await writeFixture(makeFixtureDag());
    expect(await validateCore(dagPath)).toEqual({ valid: true, errors: [] });
  });

  it('a structurally-invalid dag.json reports the real validator errors', async () => {
    const dagPath = await writeFixture(makeFixtureDag({ description: '' }));
    const result = await validateCore(dagPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'description')).toBe(true);
  });

  it('a missing dag file reports a not-found error instead of throwing', async () => {
    const missing = path.join(TMP_ROOT, 'does-not-exist', 'dag.json');
    const result = await validateCore(missing);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// snapshotCore / optimizeCore
// ---------------------------------------------------------------------------

describe('snapshotCore', () => {
  it('derives milestone a as eligible+pending, and b/c as blocked, on a fresh dag', async () => {
    const dagPath = await writeFixture(makeFixtureDag());
    const snap = await snapshotCore(dagPath);
    expect(snap.milestones['a']?.eligible).toBe(true);
    expect(snap.milestones['a']?.status).toBe('pending');
    expect(snap.milestones['b']?.eligible).toBe(false);
    expect(snap.milestones['c']?.eligible).toBe(false);
  });

  it('derives milestone b as eligible once a is recorded complete in dispatch_log', async () => {
    const dag = makeFixtureDag();
    dag.dispatch_log.push(makeCompletionLogEntry('a', ['a.1']));
    const dagPath = await writeFixture(dag);
    const snap = await snapshotCore(dagPath);
    expect(snap.milestones['a']?.status).toBe('complete');
    expect(snap.milestones['b']?.eligible).toBe(true);
    expect(snap.milestones['c']?.eligible).toBe(false);
  });
});

describe('optimizeCore', () => {
  it('packs milestone a into a DispatchUnit on a fresh dag', async () => {
    const dagPath = await writeFixture(makeFixtureDag());
    const units = await optimizeCore(dagPath);
    expect(units.length).toBeGreaterThan(0);
    expect(units.some((u) => u.milestones.includes('a'))).toBe(true);
    expect(units.some((u) => u.milestones.includes('b'))).toBe(false);
  });

  it('returns no units once every milestone is complete', async () => {
    const dag = makeFixtureDag();
    dag.dispatch_log.push(
      makeCompletionLogEntry('a', ['a.1']),
      makeCompletionLogEntry('b', ['b.1']),
      makeCompletionLogEntry('c', ['c.1'])
    );
    const dagPath = await writeFixture(dag);
    expect(await optimizeCore(dagPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// eligibleCore
// ---------------------------------------------------------------------------

describe('eligibleCore', () => {
  it('returns only the root milestone on a fresh dag', async () => {
    const dagPath = await writeFixture(makeFixtureDag());
    expect(await eligibleCore(dagPath)).toEqual(['a']);
  });

  it('surfaces b once a is recorded complete in dispatch_log', async () => {
    const dag = makeFixtureDag();
    dag.dispatch_log.push(makeCompletionLogEntry('a', ['a.1']));
    const dagPath = await writeFixture(dag);
    expect(await eligibleCore(dagPath)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// statusCore
// ---------------------------------------------------------------------------

describe('statusCore', () => {
  it('reports pending/no-logged-ops for every milestone on a fresh dag', async () => {
    const dagPath = await writeFixture(makeFixtureDag());
    const report = await statusCore(dagPath);
    expect(report['a']).toEqual({
      status: 'pending',
      loggedOperationIds: [],
      tokensEstimated: report['a']?.tokensEstimated ?? null,
      tokensActual: null,
    });
    expect(report['b']?.status).toBe('pending');
    expect(report['c']?.status).toBe('pending');
  });

  it('reports loggedOperationIds only for operations with a recorded dispatch_log result', async () => {
    const dag = makeFixtureDag();
    dag.dispatch_log.push(makeCompletionLogEntry('a', ['a.1']));
    const dagPath = await writeFixture(dag);
    const report = await statusCore(dagPath);
    expect(report['a']?.status).toBe('complete');
    expect(report['a']?.loggedOperationIds).toEqual(['a.1']);
    expect(report['b']?.loggedOperationIds).toEqual([]);
    expect(report['b']?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// runCycleCore — the paid-boundary-adjacent command; MockAgentRunner only.
// ---------------------------------------------------------------------------

describe('runCycleCore', () => {
  it('dryRun=true dispatches milestone a via an injected MockAgentRunner and persists a passing dispatch_log entry to disk', async () => {
    const dagPath = await writeFixture(makeFixtureDag());
    const debugDir = path.join(TMP_ROOT, `mock-debug-${caseN}`);
    const runner = new MockAgentRunner({ debugDir });

    const result = await runCycleCore(dagPath, true, runner);

    expect(result.terminal).toBe(false);
    expect(result.persisted).toBe(true);
    expect(result.dispatched.some((d) => d.milestones.includes('a'))).toBe(true);
    expect(runner.firedUnits.some((u) => u.milestones.includes('a'))).toBe(true);

    // CONSUMER OUTCOME: re-read the dag file back from disk via a FRESH client.
    const reloaded = await buildClient(dagPath).load();
    const guardResult = reloaded.dispatch_log
      .flatMap((e) => e.results)
      .find((r) => r.op_id === 'a.guard');
    expect(guardResult?.guard_result).toBe('pass');

    // Both completion rules this package relies on now agree "a" is done —
    // "b" becomes eligible without any hand-built dispatch_log entry.
    expect(await eligibleCore(dagPath)).toEqual(['b']);

    runner.cleanup();
  });

  it('with no runnerOverride, dryRun=true wires the internal default MockAgentRunner (never the real, paid runner)', async () => {
    const dagPath = await writeFixture(makeFixtureDag());
    const result = await runCycleCore(dagPath, true);
    expect(result.persisted).toBe(true);
    // Proves the default wiring path actually ran (not a no-op): a real
    // MockAgentRunner.fire() always writes a debug file for the fired agent,
    // under this package's OWN tmp namespace (DEFAULT_RUN_DEBUG_DIR) — never
    // dispatch-orchestrator's default, and never a network call.
    const files = fs.readdirSync(DEFAULT_RUN_DEBUG_DIR);
    expect(files.some((f) => f.startsWith('agent-'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calibrateCore — a real "null task" through MockAgentRunner; NEVER the real
// AgentMcpRunner and NEVER the real home directory.
// ---------------------------------------------------------------------------

describe('assertModelTier', () => {
  it('accepts the three real model tiers', () => {
    expect(assertModelTier('Haiku')).toBe('Haiku');
    expect(assertModelTier('Sonnet')).toBe('Sonnet');
    expect(assertModelTier('Opus')).toBe('Opus');
  });

  it('throws a clear error for an unknown tier', () => {
    expect(() => assertModelTier('Gpt5')).toThrow(/unknown modelTier 'Gpt5'/);
  });
});

describe('calibrateCore', () => {
  it('measures B via an injected MockAgentRunner and writes it to an injected path under tmp/', async () => {
    const outputPath = path.join(TMP_ROOT, 'calibration', 'dispatch-calibration.json');
    const runner = new MockAgentRunner({
      debugDir: path.join(TMP_ROOT, 'calibrate-debug'),
      defaultResult: {
        status: 'completed',
        usage: {
          direct: { inputTokens: 123, outputTokens: 45, modelCalls: 1, toolCallCount: 0, latencyMs: 10 },
          subtree: { inputTokens: 123, outputTokens: 45, modelCalls: 1, toolCallCount: 0, latencyMs: 10 },
          taskCount: 1,
        },
      },
    });

    const result = await calibrateCore('Haiku', runner, outputPath, {
      poll: { intervalMs: 0, timeoutMs: 0 },
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      modelTier: 'Haiku',
      measuredB: 168,
      inputTokens: 123,
      outputTokens: 45,
      writtenTo: outputPath,
    });
    expect(runner.firedUnits).toHaveLength(1);
    expect(runner.firedUnits[0]?.model).toBe('Haiku');

    // CONSUMER OUTCOME: the file on disk, re-read fresh.
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, number>;
    expect(written).toEqual({ Haiku: 168 });

    runner.cleanup();
  });

  it('merges into an existing calibration file, preserving other tiers already recorded there', async () => {
    const outputPath = path.join(TMP_ROOT, 'calibration-merge', 'dispatch-calibration.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ Opus: 9999 }), 'utf8');

    const runner = new MockAgentRunner({
      debugDir: path.join(TMP_ROOT, 'calibrate-merge-debug'),
      defaultResult: {
        status: 'completed',
        usage: {
          direct: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCallCount: 0, latencyMs: 1 },
          subtree: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCallCount: 0, latencyMs: 1 },
          taskCount: 1,
        },
      },
    });

    await calibrateCore('Sonnet', runner, outputPath, {
      poll: { intervalMs: 0, timeoutMs: 0 },
      sleep: async () => undefined,
    });

    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, number>;
    expect(written).toEqual({ Opus: 9999, Sonnet: 15 });

    runner.cleanup();
  });

  it('rejects an unknown model tier before ever touching the runner or the filesystem', async () => {
    const outputPath = path.join(TMP_ROOT, 'calibration-reject', 'dispatch-calibration.json');
    const runner = new MockAgentRunner({ debugDir: path.join(TMP_ROOT, 'calibrate-reject-debug') });

    await expect(calibrateCore('NotATier', runner, outputPath)).rejects.toThrow(
      /unknown modelTier 'NotATier'/
    );
    expect(runner.firedUnits).toHaveLength(0);
    expect(fs.existsSync(outputPath)).toBe(false);

    runner.cleanup();
  });
});
