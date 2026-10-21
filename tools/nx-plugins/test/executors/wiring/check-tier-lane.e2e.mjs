/**
 * check-tier-lane.e2e.mjs — the G9 header check, run as the pre-push hook and CI run it, refuses a tier P test named
 * into the pre-push `test` lane.
 *
 * guards: `node check-test-headers.mjs` exits 0 for a workspace whose tier P test is named `*.spec.ts`, so the
 *   pre-push hook (which runs it before `nx affected -t test`) lets a tier P suite into every push.
 * tier: P (spawns the check as a process over a temporary workspace; the build-tools `node --test` e2e lane,
 *   `test:build-tools-e2e`, CI only)
 * gap: This cannot be observed at tier S because the exit status the hook acts on exists only when the script runs as a
 *   process; the tier S half (check-tier-lane.spec.mjs) proves the rule through judge() and evaluate().
 * cites: owner order 2026-10-15 "directly stop pre push from running e2e or P tier" (backlog f3683008
 *   AC1); STRATEGY G9.
 * teeth: red 2026-10-15: node --test tools/nx-plugins/test/executors/wiring/check-tier-lane.e2e.mjs with the H5 push in
 *   judge() disabled -> exit 1 (the `.spec.ts` case got status 0, expected 1). Green restored: exit 0.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-test-headers.mjs');
const hdr = (lines) => `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */\n`;
const GAP = 'gap: This cannot be observed at tier S because the server binds a real socket.';

/** Run the real check over a one-file workspace; returns the child's exit status and stderr. */
function check(rel, src) {
  const root = mkdtempSync(join(tmpdir(), 'tier-lane-'));
  try {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
    const r = spawnSync(process.execPath, [SCRIPT, '--workspace-root', root, '--baseline', join(root, 'b.json')], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the G9 check as the hook runs it', () => {
  test('exit 1 for a tier P header in a .spec.ts file, naming H5', () => {
    const r = check('pkg/src/server.spec.ts', hdr(['guards: g', 'tier: P', 'cites: c', GAP]));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /pkg\/src\/server\.spec\.ts violates H5/);
  });

  test('exit 0 for the same tier P test named .e2e.ts', () => {
    const r = check('pkg/src/server.e2e.ts', hdr(['guards: g', 'tier: P', 'cites: c', GAP]));
    assert.equal(r.status, 0, r.stderr);
  });

  test('exit 0 for a tier S header in a .spec.ts file', () => {
    const r = check('pkg/src/parse.spec.ts', hdr(['guards: g', 'tier: S', 'cites: c']));
    assert.equal(r.status, 0, r.stderr);
  });
});
