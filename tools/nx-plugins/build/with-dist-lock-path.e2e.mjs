/**
 * with-dist-lock-path.e2e.mjs - the documented standalone usage of with-dist-lock.mjs resolves its child command.
 *
 * guards: `node entrypoint/backlog/tools/with-dist-lock.mjs vitest ...` (the usage documented in the script header)
 *   fails with `spawn vitest ENOENT` when run outside nx, because the child spawn relied on nx having put
 *   node_modules/.bin on PATH.
 * tier: P (spawns node, which spawns the node_modules/.bin/vitest shim; the build-tools `node --test` lane, 10 s per test).
 * gap: This cannot be observed at tier S because PATH lookup of the child happens in the operating system's spawn, in a
 *   real process started with a real environment that lacks node_modules/.bin; no in-process call reproduces it.
 * cites: backlog fix-dist-lock-path (feat/fix-dist-lock-path), criterion: documented usage works outside nx.
 * teeth: red, before the fix: node --test tools/nx-plugins/build/with-dist-lock-path.e2e.mjs -> exit 1; the wrapper
 *   printed `with-dist-lock: failed to spawn "vitest": spawn vitest ENOENT` and exited 1 (AssertionError 1 !== 0, stderr as quoted).
 *   green, after the fix: exit 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'entrypoint', 'backlog', 'tools', 'with-dist-lock.mjs');

test('with-dist-lock runs a command that only node_modules/.bin provides, with a minimal PATH', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dist-lock-path-'));
  try {
    // A PATH holding only node and the system shell: no node_modules/.bin, as outside nx.
    symlinkSync(process.execPath, join(bin, 'node'));
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: bin };
    const r = spawnSync(process.execPath, [SCRIPT, 'vitest', '--version'], { cwd: bin, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /vitest\/\d/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
