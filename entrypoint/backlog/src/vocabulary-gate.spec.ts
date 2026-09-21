/**
 * vocabulary-gate.spec.ts — SPEC.md AC-1's vocabulary-invariant half, plus
 * the real-vs-fake embedding test policy: these gates enforce their
 * invariant only when a human remembers to type the command — and none of
 * `tools/gate/vocabulary-gate.mjs` (source-tree scan),
 * `scripts/check-vocabulary.mjs` (packed-tarball scan), or
 * `tools/gate/embedding-usage-gate.mjs` (real-vs-fake embedding bucket
 * check) run as part of the test suite on their own, so a regression can
 * land and stay green until someone manually invokes them. This file wires
 * all three into the suite via real `spawnSync` process launches — never an
 * import of their internals, since the whole point is to prove the SAME
 * thing a human running the documented command would see, including the
 * packed-artifact half a source-only check structurally cannot catch.
 *
 * Real components throughout: every script runs as a real child process
 * against the real `src/` tree and (for the tarball gate) a real `npm pack`
 * of this package — never a mock, never a re-implementation of their logic
 * in-process.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = join(__dirname, '..');

function runNodeScript(
  relativeScriptPath: string,
  args: string[] = []
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, relativeScriptPath), ...args],
    {
      cwd: packageRoot,
      encoding: 'utf8',
    }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('vocabulary gates run as part of the suite (SPEC.md AC-1)', () => {
  it('the source-tree gate (tools/gate/vocabulary-gate.mjs) exits 0 against the live src/ tree', () => {
    const { status, stdout, stderr } = runNodeScript(
      'tools/gate/vocabulary-gate.mjs'
    );
    expect(
      status,
      `tools/gate/vocabulary-gate.mjs exited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    ).toBe(0);
  });

  it('the shipped-artifact gate (scripts/check-vocabulary.mjs) exits 0 against a real packed tarball', () => {
    const { status, stdout, stderr } = runNodeScript(
      'scripts/check-vocabulary.mjs',
      [packageRoot]
    );
    expect(
      status,
      `scripts/check-vocabulary.mjs exited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    ).toBe(0);
  }, 180_000); // generous: this gate runs a real `npm pack` of the package

  it('the embedding-usage gate (tools/gate/embedding-usage-gate.mjs) exits 0 — every embedding-touching spec is a declared real-by-design or faked file', () => {
    const { status, stdout, stderr } = runNodeScript(
      'tools/gate/embedding-usage-gate.mjs'
    );
    expect(
      status,
      `tools/gate/embedding-usage-gate.mjs exited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    ).toBe(0);
  });
});
