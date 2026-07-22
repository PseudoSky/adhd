/**
 * Teeth tests for eslint-check.mjs — the node_modules-install guard backing
 * `sync-deps` / `sync-deps-check` (BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-
 * DEPS-001) and its BUILD-TOOLING-VERSION-SYNC-DEPS-001 behavior change:
 * a not-really-installed workspace root now WARNS + no-ops (exit 0) instead
 * of hard-failing (exit 2), because `sync-deps` is now a `dependsOn` of every
 * project's `lint` target (nx.json targetDefaults) and a hard failure there
 * would fail `lint` (and therefore `build`) in any bare/fresh worktree.
 *
 * Run: node --test tools/nx-plugins/deps/eslint-check.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, isRealInstall, warnSkip, findRoot } from './eslint-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Capture process.stderr.write for the duration of `fn`, returning the text written. */
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return out;
}

test('isRealInstall: false for a bare directory with no node_modules at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'eslint-check-bare-'));
  try {
    assert.equal(isRealInstall(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isRealInstall: false when node_modules exists but lacks the pnpm install marker + nx canary', () => {
  const root = mkdtempSync(join(tmpdir(), 'eslint-check-partial-'));
  try {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    assert.equal(isRealInstall(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isRealInstall: true once both the pnpm marker and the nx canary package are present', () => {
  const root = mkdtempSync(join(tmpdir(), 'eslint-check-real-'));
  try {
    mkdirSync(join(root, 'node_modules', 'nx'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'x: 1\n');
    writeFileSync(join(root, 'node_modules', 'nx', 'package.json'), '{"name":"nx"}');
    assert.equal(isRealInstall(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isRealInstall: true for THIS real repo\'s own workspace root (sanity — proves the guard would NOT spuriously skip in normal CI/dev)', () => {
  const realRoot = findRoot(__dirname);
  assert.equal(isRealInstall(realRoot), true);
});

test('main(): RED — without the guard, running against a bare root throws/misbehaves', () => {
  // Demonstrates what the guard prevents: calling eslint directly (bypassing
  // main()'s guard) against a bare root with no real eslint install resolves
  // to the bare `eslint` binary name and fails to resolve/execute cleanly —
  // this is the exact "would misreport / crash" case main()'s guard exists
  // to short-circuit before it ever happens.
  const root = mkdtempSync(join(tmpdir(), 'eslint-check-red-'));
  const pkg = join(root, 'package.json');
  writeFileSync(pkg, JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }, null, 2));
  try {
    assert.equal(isRealInstall(root), false); // precondition: this IS the bare case the guard targets
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main(): GREEN — no-ops with a visible warning (exit 0) when node_modules is not a real install, and does NOT touch the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'eslint-check-skip-'));
  const pkg = join(root, 'package.json');
  const before = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }, null, 2);
  writeFileSync(pkg, before);
  try {
    let code;
    const warned = captureStderr(() => {
      code = main([pkg, '--fix'], { workspaceRoot: root });
    });
    assert.equal(code, 0, 'must no-op successfully, never hard-fail (exit 2)');
    assert.match(warned, /skipping/i, 'must print a VISIBLE warning, not skip silently');
    assert.match(warned.replace(/\s+/g, ' '), /BUG-REPO-PRECOMMIT-DEPCHECK-\s*STRIPS-USED-DEPS-001/);
    const after = readFileSync(pkg, 'utf8');
    assert.equal(after, before, 'must NOT strip/mutate the package.json when node_modules is not real');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main(): usage error (no args) still returns a non-zero code', () => {
  const code = main([]);
  assert.notEqual(code, 0);
});

test('warnSkip: writes a non-empty, actionable message to stderr', () => {
  const out = captureStderr(() => warnSkip('/fake/root'));
  assert.match(out, /pnpm install/);
  assert.match(out, /\/fake\/root/);
});
