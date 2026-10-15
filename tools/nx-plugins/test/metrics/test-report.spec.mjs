/**
 * test-report.spec.mjs: the report CLI over a seeded store: its subcommands, exit codes (0 report ok or insufficient
 * history, 1 gate violation under --check or for g5 and g7, 65 usage), and the repeat-run mode that finds a test with
 * both outcomes on the same code.
 *
 * guards: a gate violation exits 0, a clean history exits 1, or the repeat-run misses a test whose outcome changes
 *   between runs of one command.
 * tier: P (spawns the CLI and, for repeat, a child command; build-tools `node --test` lane; the in-process cases are
 *   tier S and the file is classified by its heaviest case).
 * gap: This cannot be observed at tier S because the process exit status, the stdout/stderr split and the environment
 *   a repeat-run hands its child command exist only when the CLI runs as a process.
 * cites: 595965cc T36.AC1 (repeat-run reports a test with both outcomes), T37.AC2 (over-budget test listed, fails at the
 *   configured severity).
 * teeth: red 2026-10-15: `node --test test-report.spec.mjs` -> exit 1 with `offenders --check` ignored (1 case) and with g5 never
 *   failing (1 case); a limit option shadowing G5's share limit failed the g5 case before it was fixed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, parseArgs } from './test-report.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'test-report.mjs');
const STORE_MODULE = join(dirname(fileURLToPath(import.meta.url)), 'store.mjs');

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-report-'));
  file = join(dir, 'store.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const rec = (o = {}) => ({
  kind: 'test', v: 1, runId: `r${n++}`, runner: 'vitest', group: null, project: 'p', file: 'a.spec.ts', name: 't', tier: 'S', tierSource: 'header',
  outcome: 'pass', durationMs: 1, retryCount: 0, gitSha: 'sha', dirty: false, branch: 'main', mainline: true, ts: '2026-10-14T00:00:00.000Z', loadAvgStart: 1, cpus: 10, ...o,
});
const seed = (records) => writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

describe('exit codes as a process', () => {
  const slow = [rec({ name: 'slow', durationMs: 2500 })];
  const mixed = [rec({ name: 'flaky', outcome: 'pass' }), rec({ name: 'flaky', outcome: 'fail' })];

  it('offenders --check exits 1 and names the over-budget test; without --check it exits 0', () => {
    seed(slow);
    const failing = cli(['offenders', '--check', '--file', file]);
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /a\.spec\.ts :: slow/);
    assert.equal(cli(['offenders', '--file', file]).status, 0);
  });

  it('NEGATIVE CONTROL: a clean store exits 0 under every --check and gate command', () => {
    seed([rec({ name: 'fast', durationMs: 3 })]);
    for (const args of [['offenders', '--check'], ['flaky', '--check'], ['g5'], ['g7'], ['g7', '--budget-severity', 'fail']]) {
      const r = cli([...args, '--file', file]);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
  });

  it('flaky --check and g5 exit 1 for a test with both outcomes on one sha', () => {
    seed(mixed);
    assert.equal(cli(['flaky', '--check', '--file', file]).status, 1);
    const g5 = cli(['g5', '--file', file]);
    assert.equal(g5.status, 1);
    assert.match(g5.stdout, /G5 FAIL/);
  });

  it('g7 --budget-severity fail exits 1 on an over-budget test that the default only warns about', () => {
    seed(slow);
    assert.equal(cli(['g7', '--file', file]).status, 0);
    assert.equal(cli(['g7', '--budget-severity', 'fail', '--file', file]).status, 1);
  });

  it('g7 says insufficient history, and exits 0, with fewer than five prior mainline runs; an empty store likewise', () => {
    seed([rec({ name: 'a' }), rec({ name: 'a' })]);
    const r = cli(['g7', '--file', file]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /insufficient history/);
    const empty = cli(['g5', '--file', join(dir, 'missing.jsonl')]);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /insufficient history/);
  });

  it('--gate exits 78 (unmeasured) on insufficient history for g5 and g7, never 0; a real violation still exits 1', () => {
    seed([rec({ name: 'a' }), rec({ name: 'a' })]);
    assert.equal(cli(['g7', '--gate', '--file', file]).status, 78);
    assert.equal(cli(['g5', '--gate', '--file', join(dir, 'missing.jsonl')]).status, 78);
    seed(slow);
    assert.equal(cli(['g7', '--gate', '--budget-severity', 'fail', '--file', file]).status, 1);
  });

  it('g5 honors --quarantine: a quarantined flake passes and is listed; an expired entry fails; --no-retry-scan keeps the case hermetic', () => {
    seed(mixed);
    const reg = join(dir, 'q.json');
    writeFileSync(reg, JSON.stringify({ entries: [{ test: 'a.spec.ts :: flaky', id: 'abcdef12', until: '2099-01-01', reason: 'x' }] }));
    const held = cli(['g5', '--no-retry-scan', '--quarantine', reg, '--file', file]);
    assert.equal(held.status, 0, held.stdout);
    assert.match(held.stdout, /quarantined \(still runs, not gated\).*flaky/);
    writeFileSync(reg, JSON.stringify({ entries: [{ test: 'a.spec.ts :: flaky', id: 'abcdef12', until: '2020-01-01', reason: 'x' }] }));
    const expired = cli(['g5', '--no-retry-scan', '--quarantine', reg, '--file', file]);
    assert.equal(expired.status, 1);
    assert.match(expired.stdout, /quarantine-expired/);
  });

  it('g5 fails on an untracked retry in a runner config even when the store has no history, and never reports it as unmeasured', () => {
    const repo = join(dir, 'repo');
    spawnSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'vitest.config.ts'), 'export default { test: { retry: 2 } };\n');
    spawnSync('git', ['add', 'vitest.config.ts'], { cwd: repo });
    const r = cli(['g5', '--gate', '--workspace-root', repo, '--file', join(dir, 'missing.jsonl')]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /retry-unannotated/);
  });

  it('exits 65 with a message for an unknown subcommand or option', () => {
    assert.equal(cli(['nope']).status, 65);
    const r = cli(['summary', '--bogus']);
    assert.equal(r.status, 65);
    assert.match(r.stderr, /unknown option --bogus/);
  });

  it('honors ADHD_TEST_TIMINGS_DIR for the default store', () => {
    seed([rec({ name: 'only' })]);
    writeFileSync(join(dir, 'test-metrics.jsonl'), `${JSON.stringify(rec({ name: 'via-env' }))}\n`);
    const r = cli(['history', 'via-env'], { ADHD_TEST_TIMINGS_DIR: dir, ADHD_TEST_METRICS_FILE: '' });
    assert.match(r.stdout, /via-env/);
  });
});

describe('repeat', () => {
  // The child command appends one record per invocation through the real store module; its outcome alternates with a
  // counter file, so across the repeat group the same test passes once and fails once.
  const child = (counter) => `
    import { appendRecords } from ${JSON.stringify(STORE_MODULE)};
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const c = ${JSON.stringify(counter)};
    const k = existsSync(c) ? Number(readFileSync(c, 'utf8')) : 0;
    writeFileSync(c, String(k + 1));
    const stable = process.env.STABLE === '1';
    await appendRecords(${JSON.stringify(file)}, [{ kind: 'test', runId: 'child-' + k, group: process.env.ADHD_TEST_RUN_GROUP, project: 'p', file: 'x.spec.ts', name: 'alternates', tier: 'S', outcome: stable || k % 2 === 0 ? 'pass' : 'fail', durationMs: 1, retryCount: 0, gitSha: null, dirty: true, ts: new Date().toISOString() }]);
  `;

  it('runs the command N times as one group and exits 1 naming the test whose outcome changed', () => {
    const counter = join(dir, 'count-a');
    const r = cli(['repeat', '--times', '4', '--file', file, '--', process.execPath, '--input-type=module', '-e', child(counter)]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /MIXED OUTCOMES \(1\)/);
    assert.match(r.stdout, /x\.spec\.ts :: alternates/);
    assert.equal(readFileSyncSafe(counter), '4', 'the command ran exactly --times times');
  });

  it('NEGATIVE CONTROL: a command whose outcome never changes exits 0', () => {
    const counter = join(dir, 'count-b');
    const r = cli(['repeat', '--times', '3', '--file', file, '--', process.execPath, '--input-type=module', '-e', child(counter)], { STABLE: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no test has both outcomes/);
  });
});

function readFileSyncSafe(f) {
  return spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(f)},'utf8'))`], { encoding: 'utf8' }).stdout;
}

describe('in-process', () => {
  it('parseArgs rejects bad severities, tiers and repeat counts, and a repeat with no command', () => {
    assert.match(parseArgs(['g7', '--budget-severity', 'loud']).error, /warn or fail/);
    assert.match(parseArgs(['offenders', '--tier', 'Q']).error, /S, P, H or X/);
    assert.match(parseArgs(['repeat', '--times', '1', '--', 'x']).error, /at least 2/);
    assert.match(parseArgs(['repeat', '--times', '3']).error, /needs a command/);
    assert.match(parseArgs(['history']).error, /exactly one/);
  });

  it('summary --json is the machine form of the summary', () => {
    seed([rec({ name: 'a', durationMs: 4 }), rec({ name: 'b', durationMs: 8 })]);
    const out = [];
    const code = main(['summary', '--json', '--file', file], { out: (s) => out.push(s), err: () => {} });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.join('')).byTier.S.executed, 2);
  });

  it('--project and --tier narrow what is reported', () => {
    seed([rec({ project: 'p', durationMs: 4 }), rec({ project: 'q', tier: 'P', durationMs: 9 })]);
    const out = [];
    main(['summary', '--json', '--tier', 'P', '--file', file], { out: (s) => out.push(s), err: () => {} });
    assert.deepEqual(Object.keys(JSON.parse(out.join('')).byTier), ['P']);
  });
});
