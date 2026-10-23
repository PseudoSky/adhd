/**
 * STUB (paired, ADR 0009 D2): the real suite is the sibling `http-entry.e2e.ts` (tier P), which binds a real listening loopback socket for the adhd-policy-http entry. It runs in the
 * project's `e2e` target (CI only (`nx affected -t e2e --parallel=1`)), never in the unit `test` lane the local pre-push hook runs. This file binds
 * nothing and spawns nothing; it keeps the suite in view in the unit lane and fails if the suite leaves the e2e lane.
 *
 * guards: the http-entry.e2e.ts suite is deleted, renamed out of the e2e lane, or loses its tier P header while the unit
 *   lane stays green.
 * tier: S (reads one sibling file; no socket, no process)
 * cites: backlog f3683008 AC3; docs/plan/policy-core/tickets/T17.md (HTTP entry, E6)
 * teeth: red 2026-10-15: `npx vitest run --config entrypoint/policy/vite.config.ts src/test/functional/http-entry.spec.ts`
 *   with the sibling name misspelled in that stub -> exit 1 (ENOENT in readFileSync); restored -> exit 0. Every stub of
 *   this shape (six, f3683008) shares the one assertion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = __dirname;

describe('stub: http-entry.e2e.ts runs in the e2e lane', () => {
  it('the sibling suite exists, is named *.e2e.ts and declares tier P', () => {
    const src = readFileSync(join(HERE, '../../e2e/functional/http-entry.e2e.ts'), 'utf8');
    expect(src).toMatch(/^\s*\*\s*tier:\s*P\b/m);
  });
});
