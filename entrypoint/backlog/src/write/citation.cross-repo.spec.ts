/**
 * STUB (paired, ADR 0009 D2): the real suite is the sibling `citation.cross-repo.e2e.ts` (tier P), which drives real git
 * binaries over real temporary repositories. It runs in the project's `e2e` target (CI only (`nx affected -t e2e
 * --parallel=1`)), never in the unit `test` lane the local pre-push hook runs. This file spawns nothing; it keeps the
 * suite in view in the unit lane and fails if the suite leaves the e2e lane.
 *
 * guards: the citation.cross-repo.e2e.ts suite is deleted, renamed out of the e2e lane, or loses its tier P header while
 *   the unit lane stays green.
 * tier: S (reads one sibling file; no process)
 * cites: backlog f3683008 AC3; docs/decisions/0009-test-lanes-unit-vs-e2e.md amendment 2026-10-15
 * teeth: red 2026-10-15: `npx nx test backlog` with the sibling name misspelled in this stub -> exit 1 (ENOENT in
 *   readFileSync); restored -> exit 0.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('stub: citation.cross-repo.e2e.ts runs in the e2e lane', () => {
  it('the sibling suite exists, is named *.e2e.ts and declares tier P', () => {
    const src = readFileSync(join(HERE, 'citation.cross-repo.e2e.ts'), 'utf8');
    expect(src).toMatch(/^\s*\*\s*tier:\s*P\b/m);
  });
});
