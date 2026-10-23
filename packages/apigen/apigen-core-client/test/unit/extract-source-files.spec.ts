/**
 * STUB (paired, ADR 0009 D2): the real suite is the sibling `extract-source-files.e2e.ts` (tier P), which builds real
 * ts-morph programs over real temporary source trees (9.5 s for 3 cases). It runs in the project's `e2e` target (CI only
 * (`nx affected -t e2e --parallel=1`)), never in the unit `test` lane the local pre-push hook runs. This file compiles
 * nothing; it keeps the suite in view in the unit lane and fails if the suite leaves the e2e lane.
 *
 * guards: the extract-source-files.e2e.ts suite is deleted, renamed out of the e2e lane, or loses its tier P header while
 *   the unit lane stays green.
 * tier: S (reads one sibling file; no program build)
 * cites: backlog f3683008 AC3; docs/decisions/0009-test-lanes-unit-vs-e2e.md amendment 2026-10-15
 * teeth: red 2026-10-21: `npx vitest run src/test/extract-source-files.spec.ts` in this package with the sibling name
 *   misspelled in this stub -> exit 1 (ENOENT in readFileSync); restored -> exit 0.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('stub: extract-source-files.e2e.ts runs in the e2e lane', () => {
  it('the sibling suite exists, is named *.e2e.ts and declares tier P', () => {
    const src = readFileSync(join(__dirname, '../e2e/extract-source-files.e2e.ts'), 'utf8');
    expect(src).toMatch(/^\s*\*\s*tier:\s*P\b/m);
  });
});
