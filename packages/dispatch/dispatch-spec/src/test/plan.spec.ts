import { describe, it, expect } from 'vitest';
import { validateDagJson } from '../lib/validate.js';
import { readFileSync, existsSync } from 'fs';

describe('plan', () => {
  it('validates dispatch-production dag.json', () => {
    // __dirname is the test file's directory; resolve to workspace root.
    // NOTE: this marker must track the package's real path under
    // packages/dispatch/dispatch-spec — a prior workspace refactor moved
    // this package from packages/shared/dispatch-spec, which silently
    // broke resolution (String.split() on a non-matching substring
    // returns the original string, so the old `if (!repoRoot) return`
    // guard never fired; it just built a garbage concatenated path).
    // A missing/unresolvable path must fail loudly — never skip.
    const marker = 'packages/dispatch/dispatch-spec';
    const idx = __dirname.indexOf(marker);
    if (idx === -1) {
      throw new Error(
        `plan.spec.ts: could not find '${marker}' in __dirname (${__dirname}); update the marker if the package moved again`
      );
    }
    const repoRoot = __dirname.slice(0, idx);
    const planPath = `${repoRoot}docs/plan/dispatch-production/dag.json`;
    if (!existsSync(planPath)) {
      throw new Error(`plan.spec.ts: dag.json not found at ${planPath}`);
    }
    const dag = JSON.parse(readFileSync(planPath, 'utf-8'));
    const r = validateDagJson(dag);
    if (!r.valid) console.log(JSON.stringify(r.errors));
    expect(r.valid).toBe(true);
  });
});
