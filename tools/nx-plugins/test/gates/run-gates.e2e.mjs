/**
 * run-gates.e2e.mjs — 595965cc T30: this repository's command table and the wrapper around the workspace-standards
 * gate engine.
 *
 *   T30.AC1 the table binds every gate id G1-G12 to a command (or an honest obligation), a stage and a mechanism
 *           class, the engine runs the named stage set from it and writes ONE JSON report;
 *   T30.AC2 the exit code is the worst gate's;
 *   T30.AC3 a seeded failing gate makes the exit non-zero and the report names it.
 *   (T30.AC4, the nx cache hit, is a property of the `test-gates` target: `nx run @adhd/source:test-gates` twice, the
 *   second line reads `[local cache]`; its recorded evidence is in the task's commit message.)
 *
 * The real engine is required: if it is not installed these tests FAIL with the install command, they never skip (a
 * skipped gate is the failure STRATEGY G4 exists to stop).
 *
 * guards: the gate engine runs a different gate set than the table binds, or a failing gate exits 0.
 * tier: P (spawns the real engine and the wrapper; the build-tools `node --test` e2e (`test:build-tools-e2e`, CI only) lane, 10 s per test; the slowest case
 *   runs stage B in about 1.1 s).
 * gap: This cannot be observed at tier S because stage selection, the single report and the worst-gate exit code exist
 *   only when the engine runs as a process over the real table.
 * cites: 595965cc T30.AC1-AC3; 06508843 T03.AC3.
 * teeth: red evidence for the stage C, D, E and G cases is a changed expected set failing the equality assertion; it
 *   was not captured as a recorded command for AC1-AC3 (authorship was not separated).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TABLE, REPO_ROOT, engineArgv, engineCandidates, findEngine, splitEqualsFlags } from './run-gates.mjs';

const WRAPPER = join(REPO_ROOT, 'tools/nx-plugins/test/gates/run-gates.mjs');
const GATES = Array.from({ length: 12 }, (_, i) => `G${i + 1}`);
const NON_RELAXABLE = ['G1', 'G2', 'G4', 'G10', 'G12'];

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'run-gates-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// CI cannot provision the engine yet (backlog ca23e252): there the engine-driven cases are reported as
// `todo` against that item, never as passes. Anywhere else a missing engine is a failure, never a skip.
// skip-expiry: ca23e252 until 2026-12-31 CI cannot provision the gate engine; the engine-driven cases are todo there, never skipped locally.
const ENGINE_TODO = process.env.CI && !findEngine().engine ? 'backlog ca23e252: CI cannot provision the gate engine' : false;

const engine = () => {
  const { engine: found, tried } = findEngine();
  assert.ok(found, `the workspace-standards engine is not installed; run \`soxe install workspace-standards\` or set WORKSPACE_STANDARDS_ENGINE. Looked at: ${tried.join(', ')}`);
  return found;
};

function wrapper(args, env = {}) {
  const report = join(tmp, 'report.json');
  const r = spawnSync(process.execPath, [WRAPPER, ...args, ...(args.includes('--report') ? [] : ['--report', report])], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(readFileSync(args.includes('--report') ? args[args.indexOf('--report') + 1] : report, 'utf8'));
  } catch (e) {
    parsed = null;
    parseError = e.message; // surfaced in stderr so an assertion on the report names why it is absent
  }
  return { status: r.status, stderr: parseError ? `${r.stderr}\n[report unreadable: ${parseError}]` : r.stderr, report: parsed };
}

const table = () => JSON.parse(readFileSync(DEFAULT_TABLE, 'utf8'));

describe('595965cc T30.AC1 — the repository command table', () => {
  it('595965cc T30.AC1 binds every gate G1-G12 exactly once, each with a stage and a mechanism class', () => {
    const rows = table().gates;
    assert.deepEqual(rows.map((g) => g.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), GATES);
    for (const g of rows) {
      assert.ok(['mechanical', 'review'].includes(g.mechanism), `${g.id} mechanism`);
      assert.ok(g.stage !== undefined && [].concat(g.stage).every((s) => /^[A-H]$/.test(s)), `${g.id} stage`);
    }
  });

  it('595965cc T30.AC1 an unbuilt mechanism is a row with no command (an obligation), never a placeholder command', () => {
    for (const g of table().gates) {
      if (g.command !== undefined) assert.ok(g.command.trim().length > 0, g.id);
      else assert.ok(g['bound-by'], `${g.id} has no command and names no task that will bind one`);
    }
  });

  it('595965cc T30.AC1 the gates no class relaxes carry no classes, rigors or paths (STRATEGY §6.7)', () => {
    for (const g of table().gates.filter((x) => NON_RELAXABLE.includes(x.id))) {
      assert.equal(g.classes, undefined, g.id);
      assert.equal(g.rigors, undefined, g.id);
      assert.equal(g.paths, undefined, g.id);
    }
  });

  it('595965cc T30.AC1 the engine accepts the table: completeness, liveness and reachability all exit 0', { todo: ENGINE_TODO }, () => {
    const e = engine();
    for (const args of [['check', 'completeness', '--clauses', GATES.join(',')], ['check', 'liveness'], ['check', 'reachability']]) {
      const r = spawnSync(process.execPath, [e, ...args, '--root', REPO_ROOT, '--table', DEFAULT_TABLE, '--report', join(tmp, `${args[1]}.json`)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`);
    }
  });

  it('595965cc T30.AC1 stage B runs the static gates from the real table and writes one report', { todo: ENGINE_TODO }, () => {
    const r = wrapper(['--step', 'B']);
    const evidence = (r.report?.gates ?? []).filter((g) => g.outcome === 'fail').map((g) => {
      try {
        return `${g.id}: ${readFileSync(g.evidence, 'utf8')}`;
      } catch (e) {
        return `${g.id}: evidence unreadable (${e.message})`;
      }
    });
    assert.equal(r.status, 0, `${r.stderr}\n${evidence.join('\n')}`);
    assert.equal(r.report.kind, 'gate-report');
    assert.equal(r.report.released, false);
    assert.deepEqual(r.report.gates.filter((g) => g.selected).map((g) => g.id), ['G2', 'G3']);
    assert.equal(r.report.summary.selected, 2);
  });

  it('595965cc T30.AC1 a stage with unbound gates reports them as obligations, not passes', { todo: ENGINE_TODO }, () => {
    // Stage D binds G6, G8 and G11, which have no command; every gate that has one is swapped for a no-op so only the
    // table's honest obligations decide the outcome.
    const real = table();
    const copy = join(tmp, 'real-D-obligations.json');
    writeFileSync(copy, JSON.stringify({ ...real, gates: real.gates.map((g) => (g.command === undefined ? g : { ...g, command: 'node -e "process.exit(0)"' })) }));
    const r = wrapper(['--step', 'D', '--table', copy]);
    const { selected, passed, obligations } = r.report.summary;
    assert.equal(obligations.includes('G6'), true);
    // An obligation is never counted as a pass: every selected gate is either passed or an obligation.
    assert.equal(passed, selected - obligations.length);
    assert.ok(passed < selected, 'the obligation must not be among the passes');
  });

  // T03.AC3: stages C, D, E and G are documented as commands in AGENTS.md but were never run. Running the real
  // gate commands at E and G means a full-repo nx run-many, so this swaps each command for a no-op in a copy of
  // the real table and asserts what the engine SELECTS per stage: the stage -> gate map is what is under test.
  const NOOP = 'node -e "process.exit(0)"';
  for (const stage of ['C', 'D', 'E', 'G']) {
    it(`backlog 06508843 T03.AC3 stage ${stage} selects exactly the gates the table binds to it; unbound gates are obligations`, { todo: ENGINE_TODO }, () => {
      const real = table();
      const invokes = real.stages[stage].invokes;
      const copy = join(tmp, `real-${stage}.json`);
      writeFileSync(copy, JSON.stringify({ ...real, gates: real.gates.map((g) => (g.command === undefined ? g : { ...g, command: NOOP })) }));
      const r = wrapper(['--step', stage, '--table', copy]);
      assert.equal(r.status, 0, `${r.stderr}\n${JSON.stringify(r.report?.summary)}`);
      assert.deepEqual(r.report.gates.filter((g) => g.selected).map((g) => g.id).sort(), [...invokes].sort());
      const unbound = real.gates.filter((g) => invokes.includes(g.id) && g.command === undefined).map((g) => g.id);
      assert.deepEqual([...r.report.summary.obligations].sort(), unbound.sort());
    });
  }
});

function fixtureTable(rows) {
  const file = join(tmp, 'table.json');
  writeFileSync(
    file,
    JSON.stringify({
      gates: rows.map(([id, command]) => ({ id, command, stage: 'B', mechanism: 'mechanical' })),
      stages: { B: { invokes: rows.map(([id]) => id) } },
    }),
  );
  return file;
}

describe('595965cc T30.AC2/AC3 — exit status and naming a failure', () => {
  it('595965cc T30.AC3 a seeded failing gate makes the wrapper exit non-zero and the report names it', { todo: ENGINE_TODO }, () => {
    const t = fixtureTable([['G1', 'node -e "process.exit(0)"'], ['G2', 'node -e "process.exit(1)"']]);
    const r = wrapper(['--step', 'B', '--table', t, '--root', tmp]);
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.report.summary.failed, ['G2']);
  });

  it('595965cc T30.AC2 the exit code is the worst gate\'s', { todo: ENGINE_TODO }, () => {
    const t = fixtureTable([['G1', 'node -e "process.exit(0)"'], ['G2', 'node -e "process.exit(3)"'], ['G3', 'node -e "process.exit(2)"']]);
    const r = wrapper(['--step', 'B', '--table', t, '--root', tmp]);
    assert.equal(r.status, 3);
    assert.equal(r.report.exit, 3);
  });
});

describe('595965cc T30 — the wrapper', () => {
  it('splitEqualsFlags turns --flag=value into the two-token form the engine reads', () => {
    assert.deepEqual(splitEqualsFlags(['--step=B', '--changed', 'a=b', '--x=y=z']), ['--step', 'B', '--changed', 'a=b', '--x', 'y=z']);
  });

  it('engineArgv defaults the table, root and report but never overrides a caller\'s', () => {
    const a = engineArgv('/e/cli.mjs', ['--step=B']);
    assert.equal(a[1], 'run');
    for (const f of ['--root', '--table', '--report']) assert.ok(a.includes(f), f);
    const b = engineArgv('/e/cli.mjs', ['--step', 'B', '--table', '/t.json']);
    assert.equal(b.filter((x) => x === '--table').length, 1);
    assert.equal(b[b.indexOf('--table') + 1], '/t.json');
  });

  it('engineCandidates puts $WORKSPACE_STANDARDS_ENGINE first, then every host\'s installed skill', () => {
    const c = engineCandidates({ WORKSPACE_STANDARDS_ENGINE: '/x/cli.mjs' }, '/h');
    assert.deepEqual(c, [
      '/x/cli.mjs',
      '/h/.claude/skills/workspace-standards/engine/cli.mjs',
      '/h/.config/opencode/skills/workspace-standards/engine/cli.mjs',
      '/h/.codex/skills/workspace-standards/engine/cli.mjs',
    ]);
  });

  it('exits 70 and names every path it looked at when no engine is installed', () => {
    const r = spawnSync(process.execPath, [WRAPPER, '--step', 'B'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp, WORKSPACE_STANDARDS_ENGINE: '' },
    });
    assert.equal(r.status, 70);
    assert.match(r.stderr, /\.claude\/skills\/workspace-standards\/engine\/cli\.mjs/);
    assert.match(r.stderr, /\.codex\//);
  });
});
