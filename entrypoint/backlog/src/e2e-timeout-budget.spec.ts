/**
 * e2e-timeout-budget.spec.ts — guards the relationship between the e2e lane's
 * ENFORCED vitest timeout and the child-process budgets its suites hand their
 * spawned bins (backlog e2955e9f; child d863b3ee).
 *
 * Failure class: a test gave its OWN spawned child a generous budget (60–120s)
 * but the lane's `testTimeout: 30000` killed the test mid-work, which red the
 * 2026-09-29 `@adhd/backlog` release (`backlog:publish` depends on `e2e`).
 *
 * Pure config/source reads — no spawn, no model, no ports — so it runs in the
 * default lane on every push (not a resource-lane stub).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import e2eConfig from '../vitest.e2e.config';
import {
  DEFAULT_SPAWN_TIMEOUT_MS,
  E2E_TEST_TIMEOUT_HEADROOM_MS,
  e2eTestTimeoutMs,
  spawnTimeoutMs,
} from './test/helpers/spawn-timeout.js';

const SRC = dirname(fileURLToPath(import.meta.url));

function listE2eFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listE2eFiles(p));
    else if (e.name.endsWith('.e2e.ts')) out.push(p);
  }
  return out;
}

/** Numeric-literal child budgets (`timeoutMs: N` / `timeout: N`) in `source`. */
export function literalChildBudgets(source: string): number[] {
  const re = /\btimeout(?:Ms)?:\s*([0-9][0-9_]*)\b/g;
  const budgets: number[] = [];
  for (const m of source.matchAll(re)) budgets.push(Number(m[1].replace(/_/g, '')));
  return budgets;
}

const cfgTimeout = (e2eConfig.test as { testTimeout?: number }).testTimeout;
const cfgHookTimeout = (e2eConfig.test as { hookTimeout?: number }).hookTimeout;

describe('e2e lane timeout vs child-spawn budget (e2955e9f AC1)', () => {
  it('e2955e9f AC1: the e2e lane testTimeout is >= the spawn budget every spawn helper defaults to', () => {
    expect(cfgTimeout).toBeDefined();
    expect(cfgTimeout!).toBeGreaterThanOrEqual(spawnTimeoutMs());
    expect(cfgTimeout!).toBeGreaterThanOrEqual(DEFAULT_SPAWN_TIMEOUT_MS);
    // headroom: the child's own diagnosable ETIMEDOUT fires before the runner kill.
    expect(cfgTimeout!).toBe(spawnTimeoutMs() + E2E_TEST_TIMEOUT_HEADROOM_MS);
    expect(cfgHookTimeout!).toBeGreaterThanOrEqual(spawnTimeoutMs());
  });

  it('e2955e9f AC1: a test running N sequential children gets N budgets, not one', () => {
    expect(e2eTestTimeoutMs(4)).toBe(4 * spawnTimeoutMs() + E2E_TEST_TIMEOUT_HEADROOM_MS);
    expect(e2eTestTimeoutMs(4)).toBeGreaterThan(e2eTestTimeoutMs(1));
    // N < 1 never yields less than one budget.
    expect(e2eTestTimeoutMs(0)).toBe(e2eTestTimeoutMs(1));
  });

  it('e2955e9f AC1: no .e2e.ts hardcodes a child budget the lane testTimeout cannot cover', () => {
    const offenders: string[] = [];
    for (const f of listE2eFiles(SRC)) {
      for (const b of literalChildBudgets(readFileSync(f, 'utf8'))) {
        if (b > cfgTimeout!) offenders.push(`${f}: ${b}ms > lane testTimeout ${cfgTimeout}ms`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('e2955e9f AC1 (negative control): the scan flags a budget above the cap', () => {
    expect(literalChildBudgets('runIsolatedBin(b, a, c, { timeoutMs: 999_999 })')).toEqual([999999]);
    expect(literalChildBudgets('{ timeout: spawnTimeoutMs() }')).toEqual([]);
  });

  it('e2955e9f AC2: ir-cache.integration.e2e.ts gives its multi-spawn tests a per-test budget derived from the spawn policy', () => {
    const src = readFileSync(join(SRC, 'ir-cache.integration.e2e.ts'), 'utf8');
    expect(src).toContain('e2eTestTimeoutMs(4)');
    expect(src).toContain('e2eTestTimeoutMs(2)');
    expect(src).toContain('timeoutMs: spawnTimeoutMs()');
    expect(src).not.toMatch(/timeoutMs:\s*120_000/);
  });
});
