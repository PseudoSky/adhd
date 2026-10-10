/**
 * Unit specs for lockfile-sync.js — every pnpm spawn is a mock (`run`), so these
 * are pure and run in the unit lane (ADR-0009). Real-pnpm proofs live in
 * executors/lockfile/lockfile-gate.e2e.spec.mjs.
 *
 *   4f26493e AC2  drift detection names the offending package.json + specifier
 *   e98bb455 AC1  release step probes, relocks only when stale, never in dry-run
 *
 * Run: node --test tools/nx-plugins/build/lib/lockfile-sync.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { checkLockfile, regenerateLockfile, syncLockfileForRelease, parseOutdatedLockfile, CHECK_ARGS, REGENERATE_ARGS } =
  createRequire(import.meta.url)('./lockfile-sync.js');

// Captured verbatim from `corepack pnpm install --frozen-lockfile --lockfile-only`
// (pnpm 8.15.9) after editing packages/agent/agent-core-provider/package.json.
const REAL_STALE_STDERR = ` ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with packages/agent/agent-core-provider/package.json

Note that in CI environments this setting is true by default. If you still need to run install in such cases, use "pnpm install --no-frozen-lockfile"

    Failure reason:
    specifiers in the lockfile ({"@adhd/agent-base-types":"^2.3.10","drizzle-orm":"0.45.2"}) don't match specs in package.json ({"drizzle-orm":"0.45.2","@adhd/agent-base-types":"^9.9.9"})
`;

const ok = { status: 0, stdout: '', stderr: '' };
const stale = { status: 1, stdout: '', stderr: REAL_STALE_STDERR };

/** A scripted `run`: pops results per call and records argv. */
function scripted(...results) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return results.shift() ?? ok;
  };
  return { run, calls };
}

function workspaceDir() {
  const d = mkdtempSync(join(tmpdir(), 'lockfile-sync-'));
  writeFileSync(join(d, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(d, 'pnpm-lock.yaml'), "lockfileVersion: '6.0'\n");
  return d;
}

test('4f26493e AC2: parseOutdatedLockfile names the offending package.json and the drifted specifier', () => {
  const { manifest, drift } = parseOutdatedLockfile(REAL_STALE_STDERR);
  assert.equal(manifest, 'packages/agent/agent-core-provider/package.json');
  assert.deepEqual(drift, ['@adhd/agent-base-types: lockfile "^2.3.10" vs package.json "^9.9.9"']);
});

test('4f26493e AC2: checkLockfile is fresh on exit 0 and probes with the NON-mutating argv', () => {
  const { run, calls } = scripted(ok);
  assert.deepEqual(checkLockfile({ cwd: '/x', run }), { ok: true });
  assert.deepEqual(calls[0], ['install', '--frozen-lockfile', '--lockfile-only']);
  assert.deepEqual(CHECK_ARGS, calls[0]);
  assert.ok(!CHECK_ARGS.includes('--no-frozen-lockfile'), 'the probe must never be the mutating form');
});

test('4f26493e AC2: checkLockfile reports kind=stale with a message naming package.json and specifier', () => {
  const r = checkLockfile({ cwd: '/x', run: scripted(stale).run });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'stale');
  assert.match(r.message, /agent-core-provider\/package\.json/);
  assert.match(r.message, /@adhd\/agent-base-types: lockfile "\^2\.3\.10" vs package\.json "\^9\.9\.9"/);
  assert.match(r.message, /pnpm install --lockfile-only --no-frozen-lockfile/);
});

test('4f26493e AC2: a pnpm failure that is NOT drift is kind=error (never mistaken for staleness)', () => {
  const r = checkLockfile({ cwd: '/x', run: scripted({ status: 127, stdout: '', stderr: 'corepack: command not found' }).run });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'error');
  assert.match(r.message, /command not found/);
});

test('4f26493e AC2 NEGATIVE CONTROL: a probe that ignores the exit code would call the stale fixture fresh', () => {
  // The teeth: the stale fixture is only caught because status/ERR code is read.
  const blind = (res) => ({ ok: true, res });
  assert.equal(blind(stale).ok, true, 'a blind probe reports fresh on drift');
  assert.equal(checkLockfile({ cwd: '/x', run: scripted(stale).run }).ok, false, 'the real probe does not');
});

test('e98bb455 AC1: stale + a dirty package.json -> probe, relock (mutating argv), re-probe, action=regenerated', () => {
  const d = workspaceDir();
  try {
    const { run, calls } = scripted(stale, ok, ok);
    const r = syncLockfileForRelease({ cwd: d, dirtyPaths: ['packages/foo/foo-base-a/package.json'], run });
    assert.equal(r.action, 'regenerated');
    assert.deepEqual(calls, [CHECK_ARGS, REGENERATE_ARGS, CHECK_ARGS]);
    assert.ok(REGENERATE_ARGS.includes('--lockfile-only') && REGENERATE_ARGS.includes('--no-frozen-lockfile'));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('e98bb455 AC1: dry-run only probes (action=would-regenerate) and never calls the mutating argv', () => {
  const d = workspaceDir();
  try {
    const { run, calls } = scripted(stale);
    const r = syncLockfileForRelease({ cwd: d, dirtyPaths: ['entrypoint/cli-a/package.json'], dryRun: true, run });
    assert.equal(r.action, 'would-regenerate');
    assert.deepEqual(calls, [CHECK_ARGS]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('e98bb455 AC1: fresh lockfile -> no relock; no package.json dirty -> no pnpm call at all; non-pnpm root -> skipped', () => {
  const d = workspaceDir();
  const bare = mkdtempSync(join(tmpdir(), 'lockfile-sync-bare-'));
  try {
    const fresh = scripted(ok);
    assert.equal(syncLockfileForRelease({ cwd: d, dirtyPaths: ['a/package.json'], run: fresh.run }).action, 'fresh');
    assert.equal(fresh.calls.length, 1);

    const none = scripted();
    assert.equal(syncLockfileForRelease({ cwd: d, dirtyPaths: ['published-state.json'], run: none.run }).action, 'skipped');
    assert.equal(none.calls.length, 0);

    const nopnpm = scripted();
    assert.equal(syncLockfileForRelease({ cwd: bare, dirtyPaths: ['a/package.json'], run: nopnpm.run }).action, 'skipped');
    assert.equal(nopnpm.calls.length, 0);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('e98bb455 AC1: relock failure and a still-stale re-probe both surface as action=failed', () => {
  const d = workspaceDir();
  try {
    const boom = scripted(stale, { status: 1, stdout: '', stderr: 'ERR_PNPM_FETCH_404' });
    const r1 = syncLockfileForRelease({ cwd: d, dirtyPaths: ['a/package.json'], run: boom.run });
    assert.equal(r1.action, 'failed');
    assert.match(r1.message, /ERR_PNPM_FETCH_404/);

    const still = scripted(stale, ok, stale);
    const r2 = syncLockfileForRelease({ cwd: d, dirtyPaths: ['a/package.json'], run: still.run });
    assert.equal(r2.action, 'failed');
    assert.match(r2.message, /still not fresh/);
    assert.equal(regenerateLockfile({ cwd: d, run: scripted(ok).run }).ok, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
