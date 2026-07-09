import { describe, it, expect } from 'vitest';
import { validateDagJson } from '../lib/validate.js';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Locate the nx workspace root by walking up from `start` until `nx.json` is found.
 *
 * Replaces a hard-coded path marker ('packages/dispatch/dispatch-spec') that had to be
 * hand-edited on every move. It moved twice — packages/shared/dispatch-spec ->
 * packages/dispatch/dispatch-spec -> packages/dispatch/dispatch-base-spec — and the
 * second rename broke this test. Anchoring on nx.json is rename-proof.
 * Still fails LOUDLY (never skips) if the root cannot be found.
 */
function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'nx.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `plan.spec.ts: could not locate the nx workspace root (no nx.json) walking up from ${start}`
      );
    }
    dir = parent;
  }
}

describe('plan', () => {
  it('validates dispatch-production dag.json', () => {
    const repoRoot = findWorkspaceRoot(__dirname);
    const planPath = join(repoRoot, 'docs/plan/dispatch-production/dag.json');
    if (!existsSync(planPath)) {
      throw new Error(`plan.spec.ts: dag.json not found at ${planPath}`);
    }
    const dag = JSON.parse(readFileSync(planPath, 'utf-8'));
    const r = validateDagJson(dag);
    if (!r.valid) console.log(JSON.stringify(r.errors));
    expect(r.valid).toBe(true);
  });
});
