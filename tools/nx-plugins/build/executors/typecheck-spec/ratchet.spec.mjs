/**
 * Teeth tests for the `typecheck-spec` ratchet (ratchet.mjs).
 *
 * The gate's whole reason to exist is that `entrypoint/backlog/tsconfig.spec.json`
 * had NO compiling target — a check that could not fail. These tests prove the
 * ratchet CAN fail, on a fixture project under this repo's `tmp/` (ephemeral,
 * cleaned up in `finally`):
 *
 *   - a NEW spec type error fails even when the total matches the baseline
 *     (per-file ratchet, not just a total count);
 *   - a spec file that the tsconfig's `include` matches but which tsc does NOT
 *     check (narrowed by `exclude`) fails the coverage floor — the anti-
 *     silencing guard;
 *   - an improvement (fewer errors than baseline) still passes.
 *
 * Run: node --test tools/nx-plugins/build/executors/typecheck-spec/ratchet.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATCHET = join(__dirname, 'ratchet.mjs');

function findRepoRoot(d) {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate workspace root (nx.json)');
}
const REPO_ROOT = findRepoRoot(__dirname);

function plantFixture(label) {
  const rel = join('tmp', 'nx-build-typecheck-spec-spec', `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(REPO_ROOT, rel, 'src'), { recursive: true });
  return rel;
}

const TSCONFIG = (extra = {}) =>
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'es2022',
    },
    include: ['src/**/*.spec.ts'],
    ...extra,
  });

function write(rel, file, content) {
  mkdirSync(dirname(join(REPO_ROOT, rel, file)), { recursive: true });
  writeFileSync(join(REPO_ROOT, rel, file), content);
}

function runRatchet(rel, extraArgs = []) {
  return spawnSync(
    'node',
    [RATCHET, '--tsconfig', join(rel, 'tsconfig.json'), '--baseline', join(rel, 'baseline.json'), '--project-root', rel, ...extraArgs],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
}

function cleanup(rel) {
  rmSync(join(REPO_ROOT, rel), { recursive: true, force: true });
}

test('a clean fixture types-checks and passes (write baseline -> gate green)', () => {
  const rel = plantFixture('clean');
  try {
    write(rel, 'tsconfig.json', TSCONFIG());
    write(rel, 'src/a.spec.ts', 'export const a: number = 1;\n');
    assert.equal(runRatchet(rel, ['--write-baseline']).status, 0, 'write-baseline must succeed on a clean corpus');
    const gate = runRatchet(rel);
    assert.equal(gate.status, 0, `expected green; stdout: ${gate.stdout}, stderr: ${gate.stderr}`);
    assert.match(gate.stdout, /no regression vs baseline 0/);
  } finally {
    cleanup(rel);
  }
});

test('a NEW type error fails the gate (baseline 0 -> 1)', () => {
  const rel = plantFixture('new-error');
  try {
    write(rel, 'tsconfig.json', TSCONFIG());
    write(rel, 'src/a.spec.ts', 'export const a: number = "not a number";\n');
    write(rel, 'baseline.json', JSON.stringify({ total: 0, files: {} }));
    const gate = runRatchet(rel);
    assert.equal(gate.status, 1, `must FAIL; stdout: ${gate.stdout}, stderr: ${gate.stderr}`);
    assert.match(gate.stderr, /INCREASED above the baseline/);
    assert.match(gate.stderr, /src\/a\.spec\.ts: 0 -> 1/);
  } finally {
    cleanup(rel);
  }
});

test('PER-FILE ratchet: a new error in one file fails even when the total equals the baseline', () => {
  const rel = plantFixture('per-file');
  try {
    write(rel, 'tsconfig.json', TSCONFIG());
    // a.spec.ts is now CLEAN (was 1 in the baseline); b.spec.ts newly has 1.
    // Total is IDENTICAL (1 == 1) — a total-only ratchet would wrongly pass.
    write(rel, 'src/a.spec.ts', 'export const a: number = 1;\n');
    write(rel, 'src/b.spec.ts', 'export const b: string = 2;\n');
    write(rel, 'baseline.json', JSON.stringify({ total: 1, files: { [`${rel}/src/a.spec.ts`]: 1 } }));
    const gate = runRatchet(rel);
    assert.equal(gate.status, 1, `must FAIL on the new file's error despite an equal total; stdout: ${gate.stdout}, stderr: ${gate.stderr}`);
    assert.match(gate.stderr, /b\.spec\.ts: 0 -> 1/);
  } finally {
    cleanup(rel);
  }
});

test('COVERAGE FLOOR: a spec matched by include but NOT type-checked (excluded) fails, even with zero errors', () => {
  const rel = plantFixture('coverage-floor');
  try {
    // `include` matches excluded.spec.ts, but `exclude` stops tsc from checking
    // it — the exact "silence the gate by narrowing the config" move.
    write(rel, 'tsconfig.json', TSCONFIG({ exclude: ['src/excluded.spec.ts'] }));
    write(rel, 'src/ok.spec.ts', 'export const ok: number = 1;\n');
    write(rel, 'src/excluded.spec.ts', 'export const bad: number = "nope";\n');
    write(rel, 'baseline.json', JSON.stringify({ total: 0, files: {} }));
    const gate = runRatchet(rel);
    assert.equal(gate.status, 1, `must FAIL; stdout: ${gate.stdout}, stderr: ${gate.stderr}`);
    assert.match(gate.stderr, /does NOT type-check every file it includes/);
    assert.match(gate.stderr, /excluded\.spec\.ts/);
  } finally {
    cleanup(rel);
  }
});

test('an IMPROVEMENT below the baseline still passes (the ratchet only catches increases)', () => {
  const rel = plantFixture('improvement');
  try {
    write(rel, 'tsconfig.json', TSCONFIG());
    write(rel, 'src/a.spec.ts', 'export const a: number = 1;\n');
    write(rel, 'baseline.json', JSON.stringify({ total: 3, files: { [`${rel}/src/a.spec.ts`]: 3 } }));
    const gate = runRatchet(rel);
    assert.equal(gate.status, 0, `expected green on an improvement; stdout: ${gate.stdout}, stderr: ${gate.stderr}`);
    assert.match(gate.stdout, /fewer than baseline/);
  } finally {
    cleanup(rel);
  }
});
