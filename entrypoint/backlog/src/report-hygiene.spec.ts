/**
 * report-hygiene.spec.ts — 4a979cef + 2cf61846 B-AC13: the report artifacts
 * carry no machine-local constants and no unreproducible criterion stated as
 * fact.
 *
 * - `report/deploy-verify.sh` contains no `/Users/`, no `.worktrees/backlog-cutover`
 *   and no 40-hex sha literal: the restore-min sha and the frozen dist path come
 *   from required inputs (env, else the release manifest).
 * - every line of `report/cutover-execution-plan.md` that states the 675-delta
 *   criterion also says it is unreproducible.
 *
 * Reads source text only; the script's exit-2 behaviour is driven in
 * `report-hygiene.e2e.ts`.
 *
 * Negative control (run once, restored): re-adding a baked-in sha or the
 * worktree path to the script, or restoring the bare "675-residual = 0",
 * turns the matching row red.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPORT = join(dirname(fileURLToPath(import.meta.url)), '..', 'report');
const script = readFileSync(join(REPORT, 'deploy-verify.sh'), 'utf8');
const plan = readFileSync(join(REPORT, 'cutover-execution-plan.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(REPORT, 'release-manifest-1.0.0.json'), 'utf8')) as Record<string, unknown>;

describe('4a979cef B-AC13 — deploy-verify.sh has no host-specific constants', () => {
  it('4a979cef B-AC13 no absolute home path', () => {
    expect(script.match(/\/Users\/[A-Za-z0-9._-]+/g) ?? []).toEqual([]);
  });
  it('4a979cef B-AC13 no reference to the backlog-cutover worktree', () => {
    expect(script).not.toMatch(/\.worktrees\/backlog-cutover/);
  });
  it('4a979cef B-AC13 no 40-hex sha literal (the shas come from the environment or the manifest)', () => {
    expect(script.match(/\b[0-9a-f]{40}\b/g) ?? []).toEqual([]);
  });
  it('4a979cef B-AC13 the two inputs are required and sourced from env-or-manifest', () => {
    expect(script).toMatch(/RESTORE_MIN_SHA="\$\{RESTORE_MIN_SHA:-\$\(manifest_field restoreMinSha\)\}"/);
    expect(script).toMatch(/FROZEN_DIST="\$\{FROZEN_DIST:-\$\(manifest_field frozenDist\)\}"/);
    expect(script).toMatch(/exit 2/);
    expect(typeof manifest['restoreMinSha']).toBe('string');
    expect(typeof manifest['frozenDist']).toBe('string');
    expect(String(manifest['frozenDist'])).not.toMatch(/^\//); // repo-relative, never absolute
  });
});

describe('2cf61846 B-AC13 — the 675-delta criterion is not stated as reproducible', () => {
  it('2cf61846 B-AC13 every line naming the 675 criterion also says it is unreproducible', () => {
    const lines = plan.split('\n').filter((l) => /\b675\b/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l, l.slice(0, 120)).toMatch(/unreproducible/i);
  });
  it('2cf61846 B-AC13 the bare "675-residual = 0" acceptance is gone', () => {
    expect(plan).not.toMatch(/675-residual = 0/);
  });
});
