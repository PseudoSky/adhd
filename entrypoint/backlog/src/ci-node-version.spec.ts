/**
 * ci-node-version.spec.ts — DEBT-BACKLOG-CI-NODE22-001 regression guard.
 *
 * `@adhd/backlog` requires Node >=22 (its `@adhd/sox-graph-store`/
 * `better-sqlite3@^12` native-module toolchain — DESIGN.md §12). `nx affected`
 * runs every affected project's targets (including this one's `test`/`build`/
 * `verify-dist-load`) inside ONE job on ONE `actions/setup-node` version, so
 * the workflow-level `node-version` is the real floor this package's CI
 * targets execute under — there is no per-project override. This test reads
 * the ACTUAL workflow YAML (not a copy) so a re-pin back to <22 fails here
 * before it ever reaches a real CI run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** Every `node-version: <N>` pin found in `text`, in file order. */
function extractNodeVersionPins(text: string): number[] {
  return [...text.matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => Number(m[1]));
}

describe('CI workflow Node version floor (DEBT-BACKLOG-CI-NODE22-001)', () => {
  it('ci.yml (the workflow that runs `nx affected -t lint test build verify-dist-load`) pins Node >=22', () => {
    const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const pins = extractNodeVersionPins(text);
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin, 'ci.yml node-version').toBeGreaterThanOrEqual(22);
  });

  it("pull-request.yml's `test` job (runs `nx affected -t lint/test/verify-dist-load`) pins Node >=22", () => {
    const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'pull-request.yml'), 'utf8');
    // Isolate the `test:` job block from the unrelated `secret-scan:` job,
    // which has no reason to track this package's Node floor.
    const testJobText = text.slice(text.indexOf('\n  test:'));
    const pins = extractNodeVersionPins(testJobText);
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin, "pull-request.yml 'test' job node-version").toBeGreaterThanOrEqual(22);
  });
});
