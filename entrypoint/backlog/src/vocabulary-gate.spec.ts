/**
 * vocabulary-gate.spec.ts — SPEC.md AC-1's vocabulary-invariant half, held to
 * the AGENTS.md §7 standard: "a test that stays green when the code is broken
 * proves nothing."
 *
 * OWNERSHIP (C-22). The two vocabulary acceptance gates —
 * `tools/gate/vocabulary-gate.mjs` (source-tree scan) and
 * `scripts/check-vocabulary.mjs` (packed-tarball scan) — are owned by the
 * `vocabulary-gate` Nx target (project.json), which runs them against the LIVE
 * package and is wired into `test.dependsOn`, so both PR workflows'
 * `nx affected -t test` enforces them on every PR touching this package. This
 * spec therefore does NOT re-run them against the live tree: doing so would
 * execute the tarball gate's real `npm pack` a second time on every test run
 * for no added coverage.
 *
 * Its job instead is TEETH. Each gate is driven as a real child process
 * against a small fixture built under `tmp/backlog/`, proving it (a) passes a
 * clean fixture, (b) exits non-zero on a fixture carrying a banned token, and
 * (c) names the offending file in its output. A gate script reduced to
 * `process.exit(0)` turns these red; that negative control was run and
 * recorded when this spec landed.
 *
 * The embedding-usage gate (`tools/gate/embedding-usage-gate.mjs`) has no Nx
 * target, so its live-tree assertion stays here — the suite remains the only
 * thing that runs it.
 *
 * Real components throughout: every script runs as a real child process
 * (a real `npm pack` for the tarball gate), never a mock and never an
 * in-process re-implementation of the gate's logic.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const packageRoot = join(__dirname, '..');
const repoRoot = join(packageRoot, '..', '..');

/**
 * Assembled at runtime on purpose: the source-tree gate scans `src/`, this
 * file included, so a literal banned token written here would be a
 * self-inflicted hit. `['human', 'Id'].join('')` produces the same string
 * without the contiguous spelling the gate's regex matches.
 */
const BANNED_TOKEN = ['human', 'Id'].join('');

const fixtureBase = join(repoRoot, 'tmp', 'backlog');
mkdirSync(fixtureBase, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureBase, 'vocab-gate-fixtures-'));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** Write a named fixture directory from a `{ relativePath: contents }` map. */
function makeFixture(name: string, files: Record<string, string>): string {
  const dir = join(fixtureRoot, name);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

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

describe('vocabulary gates have teeth (SPEC.md AC-1)', () => {
  describe('source-tree gate (tools/gate/vocabulary-gate.mjs)', () => {
    it('exits 0 on a clean fixture', () => {
      const dir = makeFixture('src-clean', {
        'src/clean.ts': 'export const answer = 42;\n',
      });
      const { status, stdout, stderr } = runNodeScript(
        'tools/gate/vocabulary-gate.mjs',
        [dir]
      );
      expect(
        status,
        `expected a clean fixture to pass\nexited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      ).toBe(0);
    });

    it('exits 1 and names the file on a fixture carrying a banned token', () => {
      const dir = makeFixture('src-dirty', {
        'src/offender.ts': `export const ${BANNED_TOKEN} = 'x';\n`,
      });
      const { status, stdout, stderr } = runNodeScript(
        'tools/gate/vocabulary-gate.mjs',
        [dir]
      );
      expect(
        status,
        `expected a banned token to fail the gate\nexited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      ).toBe(1);
      expect(
        stdout + stderr,
        `expected the offending file to be named in the gate output\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      ).toContain(join('src', 'offender.ts'));
    });
  });

  describe('shipped-artifact gate (scripts/check-vocabulary.mjs)', () => {
    it('exits 1 and names the file when a packed dist/ carries a banned token', () => {
      const dir = makeFixture('tarball-dirty', {
        'package.json': JSON.stringify({
          name: 'vocab-fixture-dirty',
          version: '0.0.0',
          files: ['dist'],
        }),
        'dist/index.d.ts': `export declare const ${BANNED_TOKEN}: string;\n`,
      });
      const { status, stdout, stderr } = runNodeScript(
        'scripts/check-vocabulary.mjs',
        [dir]
      );
      expect(
        status,
        `expected a banned token to fail the tarball gate\nexited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      ).toBe(1);
      expect(
        stderr,
        `expected the offending file to be named in the gate output\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      ).toContain('dist/index.d.ts');
    }, 120_000); // real `npm pack` of the fixture

    it('exits 2 — never 0 — when the packed tarball has no dist/**/*.d.ts', () => {
      const dir = makeFixture('tarball-nodist', {
        'package.json': JSON.stringify({
          name: 'vocab-fixture-nodist',
          version: '0.0.0',
          files: ['dist'],
        }),
      });
      const { status, stdout, stderr } = runNodeScript(
        'scripts/check-vocabulary.mjs',
        [dir]
      );
      expect(
        status,
        `a tarball with no dist/*.d.ts must be a hard failure, not a silent pass\nexited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      ).toBe(2);
      expect(stderr).toMatch(/no dist/i);
    }, 120_000); // real `npm pack` of the fixture
  });

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
