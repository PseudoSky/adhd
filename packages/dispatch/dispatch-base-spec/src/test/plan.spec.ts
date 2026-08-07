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

/**
 * The only real dispatch-schema (`milestones`/`operations`) dag.json in the repo.
 *
 * `dispatch-production` was superseded by `dispatch-completion` (2026-07-16) and its
 * dir was relocated under `dispatch-completion/superseded/` — it is retained as
 * PROVENANCE, and this test consumes its dag.json purely as a real-world FIXTURE for
 * `validateDagJson`. Do not "repair" the dead package paths inside it (see
 * `docs/plan/dispatch-completion/superseded/README.md`).
 *
 * Candidate locations are probed in order so a future relocation degrades to a loud,
 * actionable failure rather than a silent skip.
 */
const DAG_FIXTURE_CANDIDATES = [
  // current: agent-final consolidation (2026-07-16) quarantined the dispatch plans
  'docs/plan/agent-final/superseded/dispatch-completion/superseded/dispatch-production/dag.json',
  'docs/plan/dispatch-completion/superseded/dispatch-production/dag.json',
  'docs/plan/dispatch-production/dag.json', // original location
];

describe('plan', () => {
  it('validates the dispatch-production dag.json fixture', () => {
    const repoRoot = findWorkspaceRoot(__dirname);
    const planPath = DAG_FIXTURE_CANDIDATES.map((c) => join(repoRoot, c)).find((p) =>
      existsSync(p)
    );
    if (!planPath) {
      throw new Error(
        `plan.spec.ts: dispatch dag.json fixture not found. Tried:\n` +
          DAG_FIXTURE_CANDIDATES.map((c) => `  - ${join(repoRoot, c)}`).join('\n') +
          `\nIf the plan moved again, add its new path to DAG_FIXTURE_CANDIDATES.`
      );
    }
    const dag = JSON.parse(readFileSync(planPath, 'utf-8'));
    const r = validateDagJson(dag);
    if (!r.valid) console.log(JSON.stringify(r.errors));
    expect(r.valid).toBe(true);
  });
});
