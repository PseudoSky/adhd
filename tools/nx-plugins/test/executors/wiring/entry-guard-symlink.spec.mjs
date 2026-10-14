/**
 * entry-guard-symlink.spec.mjs — c40c33e1: a gate script invoked through a symlinked path must run, not exit 0 silently.
 *
 * guards: a gate script whose entry guard compares an unresolved process.argv[1] with the realpathed
 *   import.meta.url never calls main() when its checkout path crosses a symlink (macOS /var -> /private/var, a
 *   symlinked dev directory), so the pre-push hook, which calls it by that logical path, passes having checked nothing.
 * tier: P (spawns node over a symlinked directory; the build-tools `node --test` lane, 10 s per test; the static scan
 *   case is tier S and the file is classified by its heaviest case).
 * gap: This cannot be observed at tier S because the divergence between process.argv[1] and import.meta.url is made
 *   by the node loader at process start and exists only when a real process is started through a real symlink.
 * cites: c40c33e1; 595965cc T32, T34.
 * teeth: red: node --test tools/nx-plugins/test/executors/wiring/entry-guard-symlink.spec.mjs -> exit 1 with the
 *   guard in check-test-headers.mjs restored to `resolve(process.argv[1]) === fileURLToPath(import.meta.url)` (the
 *   linked run prints nothing and exits 0), and the static scan fails naming the file.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

// Every script the pre-push hook calls by path and that must state a verdict on stdout.
const GATES = [
  '.githooks/lib/pre-push-flags.mjs',
  'tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs',
  'tools/nx-plugins/test/executors/wiring/check-skip-expiry.mjs',
  'tools/nx-plugins/test/executors/wiring/check-test-headers.mjs',
];

const run = (script) =>
  spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined } });

describe('c40c33e1 — a gate runs when its path crosses a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-guard-'));
  const link = join(dir, 'checkout');
  symlinkSync(realpathSync(ROOT), link, 'dir');
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const gate of GATES) {
    test(`${gate}: the linked run speaks and agrees with the real-path run`, () => {
      const real = run(join(realpathSync(ROOT), gate));
      const linked = run(join(link, gate));
      assert.ok(real.stdout.trim().length > 0, `the real-path run of ${gate} printed nothing: ${real.stderr}`);
      assert.equal(linked.stdout, real.stdout, `${gate} behaves differently through a symlinked path`);
      assert.equal(linked.status, real.status);
    });
  }
});

describe('c40c33e1 — no script keeps the fragile entry guard', () => {
  test('every tracked script that compares process.argv[1] with import.meta.url resolves real paths', () => {
    const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--', 'tools', '.githooks', 'scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(listed.status, 0, listed.stderr);
    const fragile = listed.stdout
      .split('\0')
      .filter((f) => /\.(mjs|cjs|js)$/.test(f) && !f.includes('node_modules'))
      .filter((f) => {
        const src = readFileSync(join(ROOT, f), 'utf8');
        return /process\.argv\[1\]/.test(src) && /import\.meta\.url/.test(src) && !/realpathSync/.test(src);
      });
    assert.deepEqual(fragile, [], 'these scripts silently do nothing when run through a symlinked path');
  });
});
