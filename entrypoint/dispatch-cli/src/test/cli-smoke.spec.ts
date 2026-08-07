/**
 * cli-smoke.spec.ts — the mandated DEFAULT-RUNNING smoke test for the
 * dispatch-cli entrypoint (dag.json milestone "cli", op cli.2).
 *
 * This target `dependsOn: ["generate-cli"]` (project.json), so `nx test
 * dispatch-cli` always regenerates the apigen artifact
 * (dist/packages/dispatch/dispatch-cli/cli/cli.ts) before this file runs —
 * generation and spawning are SETUP, never a reason to gate a test behind an
 * env flag (CLAUDE.md "Live testing is mandatory").
 *
 * This file NEVER imports either CLI artifact. Every assertion SPAWNS it as
 * a real child process (`npx tsx --tsconfig tsconfig.base.json <path> …`) —
 * exactly the way a human dispatcher would invoke it.
 *
 * TWO artifacts are exercised, both real, both spawned:
 *
 *  (1) The apigen-GENERATED CLI (bin/cli.ts's sibling, produced by
 *      `generate-cli`). BUG-APIGEN-CLI-001 (hyphenated-dir namespace
 *      identifiers) is fixed — `--help` lists all 7 commands, and the two
 *      commands whose types never reach `@modelcontextprotocol/sdk`
 *      (`eligible`, `status`) run correctly end-to-end. The other five
 *      (`validate`/`snapshot`/`optimize`/`run`/`calibrate`) crash at
 *      runtime with `[apigen-logical] $ref "#/definitions/<type>" cannot be
 *      resolved in run-mode` — a genuine apigen-core/apigen-logical bug
 *      (zod, reachable transitively via AgentMcpRunner's MCP SDK import,
 *      corrupts ts-json-schema-generator's shared definitions registry for
 *      unrelated primitive types). This is NOT the cli-output plugin
 *      (packages/apigen/plugins/cli, the only apigen package this milestone
 *      is authorized to fix) and is well outside this milestone's scope to
 *      root-cause. Only the two known-working commands are asserted here —
 *      asserting the other five *fail* would encode a bug as permanent
 *      expected behavior; the finding is documented in the cli milestone
 *      completion report (BACKLOG-destined) instead.
 *
 *  (2) `bin/cli.ts` — the hand-written FALLBACK the milestone's own
 *      contingency clause authorizes ("hand-write a thin commander wrapper
 *      over the SAME api.ts — the api.ts surface is the contract either
 *      way"). Calls `../src/api.ts` directly, bypassing the broken
 *      schema/dispatch() layer entirely. This is the REAL, WORKING CLI —
 *      every command is exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeCompletionLogEntry, makeFixtureDag } from './helpers/fixtures.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TSCONFIG_BASE = path.join(REPO_ROOT, 'tsconfig.base.json');
const GENERATED_CLI_PATH = path.join(
  REPO_ROOT,
  'dist',
  'entrypoint',
  'dispatch-cli',
  'cli',
  'cli.ts'
);
const FALLBACK_CLI_PATH = path.join(
  REPO_ROOT,
  'entrypoint',
  'dispatch-cli',
  'bin',
  'cli.ts'
);
const COMPILED_BIN_PATH = path.join(
  REPO_ROOT,
  'entrypoint',
  'dispatch-cli',
  'dist',
  'bin',
  'cli.js'
);
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'dispatch-cli', 'cli-smoke');
// Read-only across every test below — NEVER passed to `run`, so its
// pristine "milestone a is the only eligible one" shape never depends on
// test execution order.
const READONLY_FIXTURE_PATH = path.join(TMP_ROOT, 'dag.json');
// A separate, throwaway copy exclusively for the one dispatching (`run
// --dry-run`) test.
const RUN_FIXTURE_PATH = path.join(TMP_ROOT, 'dag-for-run.json');
// Every milestone already complete — used only to prove `--no-dry-run`
// threads `dryRun: false` through to a REAL AgentMcpRunner WITHOUT ever
// risking a paid call: `optimize()` finds zero eligible units on an
// all-complete dag, so `orchestrateCycle` returns before `runner.fire()` is
// ever reached (see @adhd/dispatch-orchestrator's `orchestrateCycle`, the
// `units.length === 0` early-return branch).
const ALL_COMPLETE_FIXTURE_PATH = path.join(TMP_ROOT, 'dag-all-complete.json');
const RUN_DEBUG_DIR = path.join(REPO_ROOT, 'tmp', 'dispatch-cli', 'run-debug');

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  const fixtureJson = JSON.stringify(makeFixtureDag(), null, 2);
  fs.writeFileSync(READONLY_FIXTURE_PATH, fixtureJson, 'utf8');
  fs.writeFileSync(RUN_FIXTURE_PATH, fixtureJson, 'utf8');

  const allComplete = makeFixtureDag();
  allComplete.dispatch_log.push(
    makeCompletionLogEntry('a', ['a.1']),
    makeCompletionLogEntry('b', ['b.1']),
    makeCompletionLogEntry('c', ['c.1'])
  );
  fs.writeFileSync(ALL_COMPLETE_FIXTURE_PATH, JSON.stringify(allComplete, null, 2), 'utf8');

  // The real, deployable artifacts must exist before we ever spawn them.
  // This target's `dependsOn: ["generate-cli"]` (project.json) guarantees
  // the generated one for the normal `nx test dispatch-cli` path — fail
  // LOUDLY here (never silently skip) if either is somehow missing.
  if (!fs.existsSync(GENERATED_CLI_PATH)) {
    throw new Error(
      `dispatch-cli smoke test: generated CLI not found at ${GENERATED_CLI_PATH} — ` +
        `run \`npx nx run dispatch-cli:generate-cli\` first. This target's ` +
        `project.json declares dependsOn: ["generate-cli"], so a normal ` +
        `\`npx nx test dispatch-cli\` always produces this file first.`
    );
  }
  if (!fs.existsSync(FALLBACK_CLI_PATH)) {
    throw new Error(`dispatch-cli smoke test: fallback CLI not found at ${FALLBACK_CLI_PATH}`);
  }
  if (!fs.existsSync(COMPILED_BIN_PATH)) {
    throw new Error(
      `dispatch-cli smoke test: compiled bin not found at ${COMPILED_BIN_PATH} — ` +
        `run \`npx nx run dispatch-cli:build-bin\` first. This target's project.json ` +
        `now declares dependsOn: ["build-bin"] on the test target (added by this fix), ` +
        `so a normal \`npx nx test dispatch-cli\` always produces this file first.`
    );
  }
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  // The `run --dry-run` test's MockAgentRunner writes its debug artifacts
  // under dispatch-cli's own stable tmp namespace (core.ts's
  // DEFAULT_RUN_DEBUG_DIR), outside TMP_ROOT — swept here too so this file
  // leaves zero residue overall.
  fs.rmSync(RUN_DEBUG_DIR, { recursive: true, force: true });
});

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns a REAL CLI artifact as a child process. Never imports either one. */
function runCli(cliPath: string, args: string[]): SpawnResult {
  const result = spawnSync('npx', ['tsx', '--tsconfig', TSCONFIG_BASE, cliPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) {
    throw new Error(
      `spawn failed for ${cliPath} ${JSON.stringify(args)}: ${String(result.error)}`
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const ALL_COMMANDS = ['validate', 'snapshot', 'optimize', 'eligible', 'status', 'run', 'calibrate'];

// ---------------------------------------------------------------------------
// (1) The apigen-GENERATED artifact — real proof of the identifier fix +
//     the two commands unaffected by the documented apigen-core bug.
// ---------------------------------------------------------------------------

describe('dispatch-cli — apigen-GENERATED artifact (dist/.../cli/cli.ts)', () => {
  it('--help exits 0 and lists every command (BUG-APIGEN-CLI-001 fix proof)', () => {
    const res = runCli(GENERATED_CLI_PATH, ['--help']);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    for (const cmd of ALL_COMMANDS) {
      expect(res.stdout, `--help output missing '${cmd}':\n${res.stdout}`).toContain(cmd);
    }
  });

  it('eligible --dag-path <fixture> exits 0 and lists only the root milestone', () => {
    const res = runCli(GENERATED_CLI_PATH, ['eligible', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual(['a']);
  });

  it('status --dag-path <fixture> exits 0 with a parseable per-milestone report', () => {
    const res = runCli(GENERATED_CLI_PATH, ['status', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const report = JSON.parse(res.stdout.trim()) as Record<string, { status: string }>;
    expect(report['a']?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// (2) bin/cli.ts — the hand-written fallback; the REAL, fully-working CLI.
// ---------------------------------------------------------------------------

describe('dispatch-cli — bin/cli.ts (fallback, fully working)', () => {
  it('--help exits 0 and lists every command', () => {
    const res = runCli(FALLBACK_CLI_PATH, ['--help']);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    for (const cmd of ALL_COMMANDS) {
      expect(res.stdout, `--help output missing '${cmd}':\n${res.stdout}`).toContain(cmd);
    }
  });

  it('validate --dag-path <fixture> exits 0 with the expected JSON envelope', () => {
    const res = runCli(FALLBACK_CLI_PATH, ['validate', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ valid: true, errors: [] });
  });

  it('snapshot --dag-path <fixture> exits 0 with a parseable snapshot', () => {
    const res = runCli(FALLBACK_CLI_PATH, ['snapshot', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const snap = JSON.parse(res.stdout.trim()) as {
      milestones: Record<string, { eligible: boolean; status: string }>;
    };
    expect(snap.milestones['a']?.eligible).toBe(true);
    expect(snap.milestones['a']?.status).toBe('pending');
    expect(snap.milestones['b']?.eligible).toBe(false);
  });

  it('optimize --dag-path <fixture> exits 0 and packs milestone a', () => {
    const res = runCli(FALLBACK_CLI_PATH, ['optimize', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const units = JSON.parse(res.stdout.trim()) as Array<{ milestones: string[] }>;
    expect(units.some((u) => u.milestones.includes('a'))).toBe(true);
  });

  it('eligible --dag-path <fixture> exits 0 and lists only the root milestone', () => {
    const res = runCli(FALLBACK_CLI_PATH, ['eligible', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual(['a']);
  });

  it('status --dag-path <fixture> exits 0 with a parseable per-milestone report', () => {
    const res = runCli(FALLBACK_CLI_PATH, ['status', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const report = JSON.parse(res.stdout.trim()) as Record<string, { status: string }>;
    expect(report['a']?.status).toBe('pending');
  });

  it('run --dag-path <fixture> (default dry-run) exits 0 and dispatches milestone a safely (MockAgentRunner — no network, no cost)', () => {
    const res = runCli(FALLBACK_CLI_PATH, ['run', '--dag-path', RUN_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const result = JSON.parse(res.stdout.trim()) as {
      persisted: boolean;
      dispatched: Array<{ milestones: string[] }>;
    };
    expect(result.persisted).toBe(true);
    expect(result.dispatched.some((d) => d.milestones.includes('a'))).toBe(true);
  });

  it('run --no-dry-run wires the REAL AgentMcpRunner but never calls it on an all-complete dag (zero eligible units)', () => {
    // Proves the flag threads dryRun:false all the way to
    // buildProductionAgentMcpRunner() WITHOUT ever risking a paid call:
    // optimize() finds nothing to pack on this fixture, so
    // orchestrateCycle's `units.length === 0` branch returns before
    // runner.ensureAgent()/fire() are ever reached.
    const res = runCli(FALLBACK_CLI_PATH, [
      'run',
      '--dag-path',
      ALL_COMPLETE_FIXTURE_PATH,
      '--no-dry-run',
    ]);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const result = JSON.parse(res.stdout.trim()) as { terminal: boolean; terminalReason: string };
    expect(result.terminal).toBe(true);
    expect(result.terminalReason).toBe('all-complete');
  });

  it('calibrate --model-tier <invalid> fails fast (exit 1) BEFORE ever touching the paid runner', () => {
    // The only calibrate invocation this suite ever makes — assertModelTier
    // throws synchronously before buildProductionAgentMcpRunner() is ever
    // called, so this is fully safe (never spawns agent-mcp, never fires a
    // billed model call).
    const res = runCli(FALLBACK_CLI_PATH, ['calibrate', '--model-tier', 'NotATier']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unknown modelTier 'NotATier'");
  });
});

// ---------------------------------------------------------------------------
// (3) The COMPILED bin (dist/bin/cli.js) — the actual, real npx-invocable
//     artifact a consumer runs post-publish. Proves DEBT-DISPATCH-022's
//     build-bin target: `node dist/bin/cli.js` directly (no tsx, no
//     ts-node), and that its `require('../src/api.js')` relative import
//     resolves correctly against the tsc-mirrored dist/src/api.js sibling
//     that build-bin's reuse of tsconfig.lib.json's whole-graph compile
//     produces.
// ---------------------------------------------------------------------------

function runCompiledBin(args: string[]): SpawnResult {
  const result = spawnSync('node', [COMPILED_BIN_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) {
    throw new Error(
      `spawn failed for ${COMPILED_BIN_PATH} ${JSON.stringify(args)}: ${String(result.error)}`
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('dispatch-cli — COMPILED bin (dist/bin/cli.js, the real npx-invocable artifact)', () => {
  it('--help exits 0 and lists every command', () => {
    const res = runCompiledBin(['--help']);
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    for (const cmd of ALL_COMMANDS) {
      expect(res.stdout, `--help output missing '${cmd}':\n${res.stdout}`).toContain(cmd);
    }
  });

  it('validate --dag-path <fixture> exits 0, proving the compiled ../src/api.js sibling import resolves correctly under dist/', () => {
    const res = runCompiledBin(['validate', '--dag-path', READONLY_FIXTURE_PATH]);
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ valid: true, errors: [] });
  });
});
