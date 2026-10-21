/**
 * quarantine.e2e.mjs: T36.AC2 (a quarantine registry excludes a test from the gating run, still runs and reports it, and
 * fails past its deadline) and T36.AC3 (a scan fails any runner config that sets a retry without a tracking item).
 *
 * guards: a quarantined test still fails G5, a quarantined test vanishes from the report, an expired or malformed
 *   quarantine passes, a retry in a runner config passes without an item or past its date, or a commented-out or `0` retry
 *   is reported as one.
 * tier: P (the pure-function cases are tier S; the last block spawns node and git against a temporary repository, so the file is
 *   classified by its heaviest case).
 * gap: This cannot be observed at tier S because the scan reads git-tracked files and exits with a status; only a real
 *   git repository and a real process show that an untracked or node_modules file is ignored and the exit code is 1.
 * cites: 595965cc T36.AC2, T36.AC3; docs/standards/testing.md section 7 (FM9, G5).
 * teeth: red 2026-10-15: `node --test quarantine.e2e.mjs` -> exit 1 with isQuarantined always false (the exclusion case),
 *   with the expiry comparison inverted (the expired case) and with the comment-line skip removed (the commented retry case).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { g5 } from './analysis.mjs';
import { checkQuarantine, isQuarantined } from './quarantine.mjs';
import { scanRetries } from './retry-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const rec = (o = {}) => ({
  kind: 'test', v: 1, runId: `r${n++}`, runner: 'vitest', group: null, project: 'p', file: 'a.spec.ts', name: 't', tier: 'S', tierSource: 'header',
  outcome: 'pass', durationMs: 1, retryCount: 0, gitSha: 'sha', dirty: false, branch: 'main', mainline: true, ts: '2026-10-14T00:00:00.000Z', loadAvgStart: 1, cpus: 10, ...o,
});
const ENTRY = { test: 'a.spec.ts :: flaky', id: 'abcdef12', until: '2026-12-31', reason: 'load-sensitive seeding' };
const flakyRecs = () => [rec({ name: 'flaky', outcome: 'pass' }), rec({ name: 'flaky', outcome: 'fail' }), rec({ name: 'steady' }), rec({ name: 'steady' })];

describe('quarantine registry (T36.AC2)', () => {
  it('without a quarantine a test with both outcomes on the same code fails G5', () => {
    const r = g5(flakyRecs());
    assert.equal(r.status, 'fail');
    assert.ok(r.violations.some((v) => v.rule === 'flake-share'));
  });

  it('a quarantined test is excluded from the verdict but is still listed with its outcomes', () => {
    const quarantine = checkQuarantine({ entries: [ENTRY] }, '2026-10-15');
    const r = g5(flakyRecs(), { quarantine });
    assert.equal(r.status, 'pass', 'the quarantined flake no longer fails the gate');
    assert.deepEqual(r.quarantined, [{ test: 'a.spec.ts :: flaky', tier: 'S', executions: 2, passes: 1, fails: 1 }]);
    assert.equal(r.tiers.S.executed, 2, 'only the gated executions are counted in the share');
  });

  it('a quarantine does not hide a different flaky test', () => {
    const recs = [...flakyRecs(), rec({ name: 'other', outcome: 'pass' }), rec({ name: 'other', outcome: 'fail' })];
    const r = g5(recs, { quarantine: checkQuarantine({ entries: [ENTRY] }, '2026-10-15') });
    assert.equal(r.status, 'fail');
  });

  it('past its deadline the entry is a violation and no longer excludes the test', () => {
    const quarantine = checkQuarantine({ entries: [ENTRY] }, '2027-01-01');
    assert.deepEqual(quarantine.active, []);
    assert.equal(quarantine.violations[0].rule, 'quarantine-expired');
    const r = g5(flakyRecs(), { quarantine });
    assert.equal(r.status, 'fail');
    assert.ok(r.violations.some((v) => v.rule === 'quarantine-expired'));
  });

  it('an entry with no test, no 8-hex id, or no real date is malformed and excludes nothing', () => {
    for (const bad of [{ ...ENTRY, test: '' }, { ...ENTRY, id: 'xyz' }, { ...ENTRY, until: '2026-02-30' }, { ...ENTRY, until: 'soon' }]) {
      const q = checkQuarantine({ entries: [bad] }, '2026-10-15');
      assert.equal(q.violations[0].rule, 'quarantine-malformed', JSON.stringify(bad));
      assert.deepEqual(q.active, []);
    }
  });

  it('isQuarantined matches by substring of `file :: name`', () => {
    assert.equal(isQuarantined([ENTRY], 'a.spec.ts :: flaky case two'), true);
    assert.equal(isQuarantined([ENTRY], 'b.spec.ts :: flaky'), false);
  });
});

describe('retry scan (T36.AC3)', () => {
  const T = { today: '2026-10-15' };
  it('flags a retry in a vitest config with no tracking item', () => {
    const v = scanRetries('export default { test: {\n  retry: 2,\n} };', T);
    assert.deepEqual(v.map((x) => [x.line, x.rule]), [[2, 'retry-unannotated']]);
  });
  it('flags retries, retry: true and the command-line forms in a manifest', () => {
    assert.equal(scanRetries('  retries: 1,', T).length, 1);
    assert.equal(scanRetries('  retry: true,', T).length, 1);
    assert.equal(scanRetries('  "command": "playwright test --retries=2"', { ...T, manifest: true }).length, 1);
    assert.equal(scanRetries('  "command": "vitest run --retry 3"', { ...T, manifest: true }).length, 1);
  });
  it('NEGATIVE CONTROL: retry 0, retries 0, a comment that mentions a retry, and no retry at all are clean', () => {
    for (const src of ['  retry: 0,', '  retries: 0,', '  // retry: 3 was removed', ' * retries: 2 hide flakes', 'export default {}']) assert.deepEqual(scanRetries(src, T), [], src);
    assert.deepEqual(scanRetries('  "command": "vitest run --retry=0"', { ...T, manifest: true }), []);
  });
  it('a retry that names an item and an unexpired date, on its line or in the comment above, is allowed', () => {
    assert.deepEqual(scanRetries('  retry: 2, // retry-ok: abcdef12 until 2026-12-31 load', T), []);
    assert.deepEqual(scanRetries('  // retry-ok: abcdef12 until 2026-12-31 load\n  // more reason\n  retry: 2,', T), []);
  });
  it('a retry whose date has passed fails, and an annotation separated from it by code does not count', () => {
    assert.equal(scanRetries('  // retry-ok: abcdef12 until 2026-01-01 x\n  retry: 2,', T)[0].rule, 'retry-expired');
    assert.equal(scanRetries('  // retry-ok: abcdef12 until 2026-12-31 x\n  other: 1,\n  retry: 2,', T)[0].rule, 'retry-unannotated');
  });
});

describe('the CLI (spawns node and git)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retry-scan-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const scan = () => spawnSync(process.execPath, [join(HERE, 'retry-scan.mjs'), '--workspace-root', dir], { encoding: 'utf8' });
  const track = (file, body) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
    execFileSync('git', ['add', file], { cwd: dir });
  };

  it('exits 1 naming the file and line for an untracked retry in a tracked vitest config, 0 once the item is named', () => {
    track('pkg/vitest.config.ts', 'export default { test: {\n  retry: 2,\n} };\n');
    const bad = scan();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /pkg\/vitest\.config\.ts:2 retry-unannotated/);
    track('pkg/vitest.config.ts', 'export default { test: {\n  retry: 2, // retry-ok: abcdef12 until 2099-01-01 load\n} };\n');
    assert.equal(scan().status, 0);
  });

  it('ignores a retry in an untracked or node_modules file', () => {
    track('node_modules/x/vitest.config.ts', 'export default { test: { retry: 5 } };\n');
    assert.equal(scan().status, 0);
  });
});
