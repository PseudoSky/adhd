/**
 * STUB (paired, ADR 0009 D2): the real suite is the sibling `r10-w1-shell-guidance-claudecli.e2e.ts` (tier P), which serves the claudecli tool bridge over a loopback HTTP socket to a real MCP client. It runs in the
 * project's `e2e` target (CI only (`nx affected -t e2e --parallel=1`)), never in the unit `test` lane the local pre-push hook runs. This file binds
 * nothing and spawns nothing; it keeps the suite in view in the unit lane and fails if the suite leaves the e2e lane.
 *
 * guards: the r10-w1-shell-guidance-claudecli.e2e.ts suite is deleted, renamed out of the e2e lane, or loses its tier P header while the unit
 *   lane stays green.
 * tier: S (reads one sibling file; no socket, no process)
 * cites: backlog f3683008 AC3; backlog 132547e7; R10 W1 AC3
 * teeth: red 2026-10-15: `npx vitest run --config entrypoint/policy/vite.config.ts src/test/functional/http-entry.spec.ts`
 *   with the sibling name misspelled in that stub -> exit 1 (ENOENT in readFileSync); restored -> exit 0. Every stub of
 *   this shape (six, f3683008) shares the one assertion.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('stub: r10-w1-shell-guidance-claudecli.e2e.ts runs in the e2e lane', () => {
  it('the sibling suite exists, is named *.e2e.ts and declares tier P', () => {
    const src = readFileSync(join(HERE, '../e2e/r10-w1-shell-guidance-claudecli.e2e.ts'), 'utf8');
    expect(src).toMatch(/^\s*\*\s*tier:\s*P\b/m);
  });
});
