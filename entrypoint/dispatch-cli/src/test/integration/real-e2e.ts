#!/usr/bin/env node
/**
 * real-e2e.ts — dag.json milestone `tests-real-e2e` (op `tests-real-e2e.1`).
 *
 * A self-executing tsx script (NOT a vitest spec — deliberately outside
 * `src/**\/*.{spec,test}.ts`, so `npx nx test dispatch-cli` never picks it up)
 * exercising the FULL dispatch-production product lifecycle end-to-end: cold
 * start -> author -> snapshot/optimize -> dispatch -> a second cycle -> a
 * guard failure -> its correction -> process resume. Every component is
 * REAL: `@adhd/dispatch-core-client`'s `DagClient` + `@adhd/dispatch-serializer-json`'s
 * real file serializer (atomic writes to a real file on disk), `@adhd/dispatch-core-optimizer`'s
 * real `snapshot()`/`optimize()`, `@adhd/dispatch-orchestrator`'s real
 * `orchestrateCycle()`, and `packages/dispatch/dispatch-cli/bin/cli.ts` (the
 * hand-written, fully-working CLI fallback) spawned as a real child process
 * for every CLI-facing assertion. The ONLY test double anywhere in the 8
 * required scenarios is `MockAgentRunner` (from `@adhd/dispatch-orchestrator`'s
 * own public export — reused, never reimplemented) standing in for the
 * agent-mcp task-runner boundary, exactly as the milestone's fixed decisions
 * require. Run:
 *
 *   npx nx build dispatch-cli && npx tsx --tsconfig tsconfig.base.json \
 *     packages/dispatch/dispatch-cli/src/test/integration/real-e2e.ts
 *
 * Exits 0 iff all 8 required scenarios pass; nonzero otherwise. Prints a
 * per-scenario result table either way.
 *
 * ---------------------------------------------------------------------------
 * FIXED DECISIONS HONORED (dispatch-production plan, milestone tests-real-e2e)
 * ---------------------------------------------------------------------------
 * R. REUSE: `MockAgentRunner` and `AgentMcpRunner` are both imported from
 *    `@adhd/dispatch-orchestrator`'s public barrel — never reimplemented.
 *    Orchestrator/optimizer/client/serializer/spec are all the real shipped
 *    `@adhd/*` packages.
 * H. Harness exports per the op shape: `setupTestEnv`, `createTestOrchestrator`
 *    (an `OrchestratorDeps` with an injected fixed clock, id factory, and
 *    zero-delay sleep — no wall-clock anywhere in this file), `readDagOnDisk`
 *    (a FRESH client/serializer re-read, never the same in-memory object),
 *    and `runCli` (a bounded `spawnSync` of `bin/cli.ts` via
 *    `npx tsx --tsconfig tsconfig.base.json`, 60s timeout, captured exit +
 *    stdout/stderr).
 * C. CLI-driven assertions spawn `bin/cli.ts` exclusively (never the
 *    apigen-GENERATED CLI under `dist/.../cli/cli.ts` — BUG-APIGEN-CORE-001
 *    crashes 5 of its 7 commands; that gap is already proven, in both
 *    directions, by this package's own `cli-smoke.spec.ts`, so re-proving it
 *    here would be redundant, not additive).
 * T. Teeth: verified by the builder via two temporary, byte-identically-
 *    restored negative controls (see the completion report) — (a) breaking
 *    `injectCorrectionMilestone` in `dispatch-orchestrator/src/lib/orchestrator.ts`
 *    turns scenario 7 (and 6) red; (b) breaking `eligibleCore` in this
 *    package's own `src/lib/core.ts` turns scenario 2 red. Not encoded as
 *    in-script self-mutation — a real source edit + real rerun, restored via
 *    `cp` + `md5` before/after comparison.
 * Z. Zero tmp residue: everything lives under `tmp/dispatch-cli/e2e/` (this
 *    package's own namespace, CLAUDE.md "Test/ephemeral artifacts"), removed
 *    in a `finally` block regardless of outcome. No `Date.now()`/`Math.random()`
 *    anywhere in an assertion — every clock/id/sleep is injected.
 *
 * ---------------------------------------------------------------------------
 * DRIFT — where the dag.json milestone's own narrative text turned out not to
 * match the REAL, shipped components it's supposed to exercise. Per the
 * mission's fixed decisions, the decisions (and, absent an explicit decision,
 * the real code) win; every deviation below is deliberate and asserts the
 * TRUE behavior, cited against the exact source that proves it.
 * ---------------------------------------------------------------------------
 * DRIFT-1 (cold start / scenario 1): the milestone text says "dispatch init
 *   --plan test-e2e creates a skeleton". No `init` command exists anywhere —
 *   `api.ts`/`bin/cli.ts` expose exactly 7 commands (validate, snapshot,
 *   optimize, eligible, status, run, calibrate), none of them `init`. The
 *   skeleton is created through the real `DagClient.saveDag()` instead — a
 *   real component, just not a nonexistent CLI subcommand.
 * DRIFT-2 (author / scenario 2): the milestone text says an agent calls
 *   "dag.milestone_add" / "dag.operation_add" MCP tools. The `tools-mcp`
 *   milestone is DEFERRED (docs/plan/dispatch-production/dag.json) and those
 *   tools do not exist on any MCP surface. The plan is authored directly
 *   through the real `DagClient`/serializer instead (load -> mutate the
 *   in-memory `DagJson` -> `saveDag`), which is exactly the same I/O contract
 *   the (not-yet-built) MCP tools would eventually sit in front of.
 * DRIFT-3 (snapshot+optimize / scenario 3): the milestone text asserts
 *   `sentinel_role === 'solo'`. `@adhd/dispatch-base-spec`'s real `SentinelRole`
 *   type is `'prewarm' | 'payload'` only (types.ts) — `'solo'` is not a
 *   member. `optimize()`'s `assembleUnit` always emits `sentinel_role: null`
 *   (sentinel-fanout role assignment is explicitly deferred — see its own
 *   doc comment). This is DEBT-DISPATCH-009, already independently discovered
 *   and documented in `dispatch-orchestrator/src/test/helpers/fixtures.ts`'s
 *   `makeUnit()` comment — this script asserts `null`, matching the real type
 *   and the real optimizer output.
 * DRIFT-4 (guard failure+correction / scenarios 6-7): the milestone text says
 *   guard failure marks the milestone "pending-surfaced", populates
 *   `open_questions[]` with `surfaced: true`, and calls the injected milestone
 *   a "review milestone". NONE of that matches the shipped orchestrator
 *   (`dispatch-orchestrator/src/lib/orchestrator.ts`): `injectCorrectionMilestone`/
 *   `injectFailureCorrection` never write `dag.pending` anywhere;
 *   `buildOpenQuestions` (`dispatch-optimizer/src/lib/snapshot.ts`) populates
 *   `open_questions[]` ONLY from a milestone's own AUTHORED `pending` field,
 *   which correction injection never touches; `deriveMilestoneStatus`'s
 *   ordering (complete > failed > in_progress > pending-surfaced > pending)
 *   means a guard failure resolves to status `'failed'`, never
 *   `'pending-surfaced'`; and the injected milestone is named
 *   `<slug>-correction-<n>` (`nextCorrectionSlug`), never "review". This is
 *   not a new finding — `dispatch-orchestrator`'s own
 *   `orchestrator.spec.ts` ("guard failure / replan injection" describe
 *   block) already asserts exactly this real behavior. This script asserts
 *   the same real facts.
 * DRIFT-5 (resume+calibrate / scenario 8): the milestone text says
 *   "dispatch calibrate Sonnet ... writes ~/.adhd/dispatch-calibration.json".
 *   `calibrate()` in `api.ts` is UNCONDITIONALLY a paid boundary — its own
 *   JSDoc: "fires a real, billed model call... NOT exercised by this
 *   package's default-running tests". This package's OWN default-running
 *   tests (`core.spec.ts`) never call it either; they call `calibrateCore`
 *   directly with an injected `MockAgentRunner` and a path under
 *   `tmp/dispatch-cli/`. This script does the exact same thing — real
 *   `calibrateCore` logic, real file I/O, `MockAgentRunner` only, and NEVER
 *   the real home directory or a real billed call.
 * DRIFT-6 (snapshot+optimize / scenario 3): the milestone text says "assert
 *   the compiled prompt contains all 3 milestone descriptions and all 5 op
 *   specs". This is structurally impossible given the SAME milestone's own
 *   scenario-2 authoring instructions (a strict `research -> interface ->
 *   implement` `depends_on` chain): `optimize()`'s `selectPackableMilestones`
 *   only ever considers ELIGIBLE + `status: 'pending'` milestones, and its
 *   own doc comment states the direct consequence: "if X depends on Y, X can
 *   only be eligible once Y is complete... two milestones with a direct
 *   dependency edge can never both appear in the candidate set at once." At
 *   the point scenario 3 runs, only `research` is eligible, so the REAL
 *   compiled prompt can only ever contain `research`'s description + its own
 *   2 ops. This script asserts that (and explicitly asserts
 *   interface/implement are ABSENT from the prompt) rather than asserting
 *   something false about the real system.
 * DRIFT-7 (dispatch / scenario 4): the milestone text implies a completed
 *   milestone's `eligible` flips to `false`. D-07's `eligible` is derived
 *   ONLY from a milestone's own `pending` field + its deps' statuses — never
 *   its own status (`optimize.ts`'s `selectPackableMilestones` doc comment,
 *   verbatim: "a milestone that has already gone complete can still read
 *   eligible: true... nothing flips it back to false"). This script asserts
 *   `eligible === true` post-completion (the real, documented behavior) and
 *   instead proves "done, won't be re-dispatched" the way the real system
 *   actually signals it: by confirming the milestone is ABSENT from a fresh
 *   `optimize()` candidate list (whose extra `status === 'pending'` filter is
 *   what actually prevents re-dispatch).
 * DRIFT-8 (dispatch / scenario 4, structural): the milestone's own dag.json
 *   text describes "Scenario 4" as the GATED real-Haiku dispatch of the
 *   SHARED `research` milestone itself — "the orchestrator fires the research
 *   milestone through a real Haiku agent-mcp dispatch (the 'real model'
 *   exception — gated behind DISPATCH_E2E_LIVE=1...)" — while the SAME
 *   milestone text elsewhere says "Scenarios S1-S3 and S5-S8 run BY DEFAULT
 *   with MockAgentRunner (deterministic, free)". Those two statements are
 *   self-contradictory: S5-S8 all depend, transitively, on `research` being
 *   dispatched and complete (S5 needs it for `interface` to become eligible,
 *   and every later scenario builds on that chain) — so if S4 (dispatching
 *   `research`) were ITSELF the gated, off-by-default scenario, S5-S8 could
 *   never run by default either, contradicting the very sentence that says
 *   they do. This script resolves the contradiction in favor of keeping ALL
 *   8 required scenarios free and deterministic: scenario 4 dispatches the
 *   shared `research` milestone via `MockAgentRunner` unconditionally, never
 *   gated. The optional live check is instead a SEPARATE, fully independent
 *   scenario (labeled 'L' in the result table) against its OWN throwaway
 *   milestone (`embedding-research`, its own isolated tmp dir under
 *   `live-scenario4/`) that the main 8-scenario lifecycle never depends on —
 *   see "LIVE GATE" below. This is a deliberate reinterpretation made to keep
 *   the required scenarios paid-call-free, not an oversight.
 *
 * Also disclosed, not a drift in this script's assertions (nothing here
 * needed to change to accommodate it) but worth recording: orchestrator.ts's
 * own `injectCorrectionMilestone` doc comment already discloses that it "does
 * not rewire any OTHER milestone's depends_on onto the correction... full
 * replan choreography belongs to workflow:plan-builder, not this minimal
 * loop." Scenario 7 confirms the direct consequence: the ORIGINAL failed
 * milestone (`implement`) can never automatically become `'complete'` again
 * through `orchestrateCycle` alone, even after its correction succeeds — this
 * is a confirmed instance of an already-disclosed gap, not a new bug.
 *
 * ---------------------------------------------------------------------------
 * LIVE GATE (optional scenario, DISPATCH_E2E_LIVE=1)
 * ---------------------------------------------------------------------------
 * One additional, fully independent scenario fires ONE real, billed agent-mcp
 * dispatch (a `claudecli`-provider agent — i.e. whatever model the local
 * `claude` CLI resolves to; `AgentMcpRunner.ensureAgent` always creates
 * `{ type: 'claudecli' }` agents regardless of `unit.model`, so the `Haiku`
 * tier set on this scenario's milestone selects only the token-accounting
 * bucket, not literally which model executes it) through the REAL
 * `AgentMcpRunner` (`npx -y @adhd/agent-mcp`), asking it to write a real file
 * to disk, then verifies via a real shell guard (`test -f <file>`) that it
 * did. This is the repo's single legitimate env-gate exception (CLAUDE.md
 * §6, "Live testing is mandatory" — a real model is a paid third-party
 * service). Per that policy the gate is disclosed in the open, with a named
 * owner, in all three required locations:
 *   1. THIS file header (here).
 *   2. `packages/dispatch/dispatch-cli/README.md`, "## Live e2e gate" section.
 *   3. The repo-root `CLAUDE.md` — NOT added by this milestone's builder; a
 *      parallel agent is authoring the closeout for this plan and is
 *      responsible for that repo-wide doc. Flagged explicitly here so it
 *      isn't silently dropped.
 *
 * Gate: `DISPATCH_E2E_LIVE=1`. Approved by: the repo owner/maintainer
 * (git user `pseudosky`, skywinstonsk@gmail.com). Skipped, with a loud
 * console notice, whenever the env var is not exactly `"1"` — never a silent
 * skip. Run it explicitly with:
 *
 *   DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json \
 *     packages/dispatch/dispatch-cli/src/test/integration/real-e2e.ts
 *
 * Requires local `claude auth status` to be configured (no API key needed —
 * `claudecli` drives the local Claude Code CLI directly) and costs real
 * money/quota when it runs.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  DagJson,
  DispatchUnit,
  MilestoneDag,
  OperationDag,
  ProviderConfig,
  ValidationResult,
} from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { snapshot, optimize } from '@adhd/dispatch-core-optimizer';
import {
  orchestrateCycle,
  MockAgentRunner,
  AgentMcpRunner,
  DEFAULT_B_PER_TIER,
  DEFAULT_CONTEXT_WINDOW_PER_TIER,
  type OrchestratorDeps,
  type IDispatchAgentRunner,
} from '@adhd/dispatch-orchestrator';

// Same-package, relative import — mirrors this package's own core.spec.ts,
// which imports `calibrateCore` the same way rather than through the public
// `@adhd/dispatch-cli` barrel.
import { calibrateCore } from '../../lib/core.js';

// ---------------------------------------------------------------------------
// ── Paths / constants ────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const TSCONFIG_BASE = path.join(REPO_ROOT, 'tsconfig.base.json');
const FALLBACK_CLI_PATH = path.join(
  REPO_ROOT,
  'packages',
  'dispatch',
  'dispatch-cli',
  'bin',
  'cli.ts'
);
// This package's own tmp namespace (CLAUDE.md "Test/ephemeral artifacts" —
// one canonical tmp/<package>/… root). Removed in main()'s finally block.
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'dispatch-cli', 'e2e');

/** A guard command that always passes — cheap, real, no network (matches the repo-wide convention). */
const PASS_GUARD = 'node -e "process.exit(0)"';

/**
 * A STATEFUL guard: fails and creates `markerPath` the first time it runs;
 * passes every time after. Used for the `implement` milestone AND (because
 * `injectCorrectionMilestone` copies `guard: original.guard` verbatim) its
 * injected correction: the first (failing) run creates the marker, so the
 * correction's own later run of the identical command finds it and passes —
 * a real, deterministic, file-existence-based stand-in for "the correction
 * actually fixed the underlying problem", with no wall-clock/random anywhere.
 */
function markerGuard(markerPath: string): string {
  return `node -e "const fs=require('fs');const p='${markerPath}';if(fs.existsSync(p)){process.exit(0)}else{fs.writeFileSync(p,'ok');process.exit(1)}"`;
}

const EMPTY_OPTIMIZATION: DagJson['optimization'] = {
  sentinel_fanout: {
    enabled: false,
    write_multiplier: 1.25,
    read_multiplier: 0.1,
    hit_probability: 0.9,
  },
  b_per_tier: {},
  context_window_per_tier: {},
  context_window_override: null,
  b_override: null,
};

// ---------------------------------------------------------------------------
// ── Assertion helpers (no test framework — this is a self-executing script) ──
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// ── Harness exports (op shape H: setupTestEnv / createTestOrchestrator /
//    readDagOnDisk / cli helpers) ─────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** Scoped tmp dir per scenario under tmp/dispatch-cli/e2e/, torn down in main()'s finally. */
export function setupTestEnv(name: string): { dir: string; dagPath: string } {
  const dir = path.join(TMP_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return { dir, dagPath: path.join(dir, 'dag.json') };
}

/** A fixed, monotonic (never wall-clock) fake ISO clock — matches dispatch-orchestrator's own test idiom. */
function makeFakeClock(): () => string {
  let n = 0;
  return () => {
    const cur = n++;
    const m = String(Math.floor(cur / 60)).padStart(2, '0');
    const s = String(cur % 60).padStart(2, '0');
    return `2026-01-01T00:${m}:${s}Z`;
  };
}

/**
 * `OrchestratorDeps` with an injected fixed clock, id factory, and
 * zero-delay sleep/poll — determinism, no wall-clock anywhere. `idPrefix`
 * disambiguates dispatch ids across the several `OrchestratorDeps` instances
 * this script builds (the main lifecycle's, and a deliberately-fresh one for
 * scenario 8's resume proof).
 */
export function createTestOrchestrator(
  dagPath: string,
  runner: IDispatchAgentRunner,
  idPrefix: string
): OrchestratorDeps {
  let idN = 0;
  return {
    client: createDagClient(createJsonFileSerializer(dagPath)),
    optimizer: { snapshot, optimize },
    runner,
    bPerTier: DEFAULT_B_PER_TIER,
    contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER,
    clock: makeFakeClock(),
    idFactory: () => `${idPrefix}-${idN++}`,
    sleep: async () => {
      /* zero-delay — never a real wall-clock wait */
    },
    poll: { intervalMs: 0, timeoutMs: 0 },
  };
}

/** A FRESH client/serializer re-read — never the same in-memory object a scenario just wrote. */
export function readDagOnDisk(dagPath: string): Promise<DagJson> {
  return createDagClient(createJsonFileSerializer(dagPath)).load();
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Bounded spawnSync of bin/cli.ts via `npx tsx --tsconfig tsconfig.base.json`, 60s timeout. */
export function runCli(args: string[]): CliResult {
  const result = spawnSync(
    'npx',
    ['tsx', '--tsconfig', TSCONFIG_BASE, FALLBACK_CLI_PATH, ...args],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 }
  );
  if (result.error) {
    throw new Error(`spawn failed for bin/cli.ts ${JSON.stringify(args)}: ${String(result.error)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// ── Fixture builders ─────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

function makeProviderConfig(): ProviderConfig {
  return {
    type: 'claudecli',
    model_id: 'claude-sonnet-e2e',
    env_secret: null,
    base_url: null,
    timeout_ms: 30_000,
    retry_config: { retries: 0, min_timeout: 0, max_timeout: 0, factor: 1 },
  };
}

function makeMilestone(opts: {
  description: string;
  agent: string;
  depends_on: string[];
  guard: string;
  model?: MilestoneDag['model'];
  effort?: MilestoneDag['effort'];
}): MilestoneDag {
  return {
    description: opts.description,
    authored_by: 'real-e2e',
    pending: null,
    triggered_by: null,
    phase: 'e2e',
    depends_on: opts.depends_on,
    agent: opts.agent,
    model: opts.model ?? 'Sonnet',
    effort: opts.effort ?? 'medium',
    two_stage: false,
    read_only: [],
    guard: opts.guard,
  };
}

function makeOp(id: string, milestone: string, depends_on: string[]): OperationDag {
  return {
    id,
    milestone,
    depends_on,
    type: 'generative',
    action: 'create',
    file: null,
    symbol: null,
    provenance: 'manual',
    confidence: 'documented',
    audit_check: null,
    criteria: [],
    tool: null,
    args: null,
    guard: null,
    to_file: null,
    to_symbol: null,
    ki_estimate: 50,
    ki_source: 'estimate',
    authored_by: 'real-e2e',
    status: 'pending',
    shape: {
      kind: 'doc',
      description: `Write the deliverable for ${id}.`,
      objective: `${id} is complete.`,
      required_sections: [],
    },
  };
}

// ---------------------------------------------------------------------------
// ── Result tracking + table ──────────────────────────────────────────────────
// ---------------------------------------------------------------------------

type ScenarioStatus = 'PASS' | 'FAIL' | 'SKIP';

interface ScenarioResult {
  id: string;
  name: string;
  status: ScenarioStatus;
  required: boolean;
  detail: string;
}

async function runScenario(
  id: string,
  name: string,
  required: boolean,
  fn: () => Promise<string>
): Promise<ScenarioResult> {
  try {
    const detail = await fn();
    return { id, name, status: 'PASS', required, detail };
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return { id, name, status: 'FAIL', required, detail };
  }
}

function printTable(results: ScenarioResult[]): void {
  const idW = Math.max(3, ...results.map((r) => r.id.length));
  const nameW = Math.max(8, ...results.map((r) => r.name.length));
  const statusW = 6;
  const headerLine = ` ${'#'.padEnd(idW)} | ${'Scenario'.padEnd(nameW)} | ${'Result'.padEnd(statusW)} | Detail`;
  const rule = '-'.repeat(Math.max(headerLine.length, 100));
  const bar = '='.repeat(rule.length);

  console.log('');
  console.log(bar);
  console.log(' real-e2e — dispatch-production fast-path lifecycle (8 required scenarios + 1 optional live)');
  console.log(bar);
  console.log(headerLine);
  console.log(rule);
  for (const r of results) {
    // One-line detail per row; embedded newlines (e.g. a stack trace on FAIL)
    // are flattened so the table stays one row per scenario.
    const flatDetail = r.detail.replace(/\s*\n\s*/g, ' | ');
    console.log(` ${r.id.padEnd(idW)} | ${r.name.padEnd(nameW)} | ${r.status.padEnd(statusW)} | ${flatDetail}`);
  }
  console.log(rule);
  const required = results.filter((r) => r.required);
  const passed = required.filter((r) => r.status === 'PASS').length;
  const failed = required.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(` RESULT: ${passed}/${required.length} required scenarios passed, ${failed} failed, ${skipped} skipped (optional)`);
  console.log(bar);
  console.log('');
}

// ---------------------------------------------------------------------------
// ── Shared lifecycle context (scenarios 2-8 are ONE continuous plan, not 8
//    disconnected fixtures — matching "the full product lifecycle end-to-end") ─
// ---------------------------------------------------------------------------

interface LifecycleCtx {
  dir: string;
  dagPath: string;
  markerPath: string;
  runner: MockAgentRunner;
  deps: OrchestratorDeps;
  failingDispatchId: string;
  correctionSlug: string;
}

// ---------------------------------------------------------------------------
// ── Scenario 1 — Cold start ──────────────────────────────────────────────────
// ---------------------------------------------------------------------------

async function scenario1(ctx: LifecycleCtx): Promise<string> {
  const { dir, dagPath } = setupTestEnv('lifecycle');
  ctx.dir = dir;
  ctx.dagPath = dagPath;
  ctx.markerPath = path.join(dir, 'implement-fixed.marker');

  assert(!fs.existsSync(dagPath), 'precondition: dag.json must not exist yet for a true cold start');

  // DRIFT-1: no `init` command exists — create the skeleton through the real
  // DagClient instead.
  const skeleton: DagJson = {
    schema_version: 4,
    plan_kind: 'greenfield',
    description: 'real-e2e test-e2e lifecycle plan',
    problem: 'prove the dispatch-production fast path end-to-end',
    approach: 'author research -> interface -> implement, then dispatch it through a full cycle',
    executor: 'real-e2e',
    phases: ['e2e'],
    terminal: '',
    optimization: EMPTY_OPTIMIZATION,
    providers: {},
    effort_max_tokens: {},
    milestones: {},
    operations: [],
    dispatch_log: [],
  };
  await createDagClient(createJsonFileSerializer(dagPath)).saveDag(skeleton);
  assert(fs.existsSync(dagPath), 'real DagClient.saveDag() must create dag.json on disk');

  const statusRes = runCli(['status', '--dag-path', dagPath]);
  assert(statusRes.status === 0, `status exit ${statusRes.status}, stderr: ${statusRes.stderr}`);
  const statusJson = JSON.parse(statusRes.stdout.trim()) as Record<string, unknown>;
  assert(
    Object.keys(statusJson).length === 0,
    `expected 0 milestones, got ${Object.keys(statusJson).length}: ${statusRes.stdout}`
  );

  const eligibleRes = runCli(['eligible', '--dag-path', dagPath]);
  assert(eligibleRes.status === 0, `eligible exit ${eligibleRes.status}, stderr: ${eligibleRes.stderr}`);
  const eligibleJson = JSON.parse(eligibleRes.stdout.trim()) as unknown[];
  assert(
    Array.isArray(eligibleJson) && eligibleJson.length === 0,
    `expected 0 eligible, got ${JSON.stringify(eligibleJson)}`
  );

  return (
    "dag.json created via the real DagClient (DRIFT-1: no CLI 'init' command exists); " +
    `spawned 'status' -> 0 milestones (exit ${statusRes.status}); spawned 'eligible' -> [] (exit ${eligibleRes.status})`
  );
}

// ---------------------------------------------------------------------------
// ── Scenario 2 — Author plan ─────────────────────────────────────────────────
// ---------------------------------------------------------------------------

async function scenario2(ctx: LifecycleCtx): Promise<string> {
  const client = createDagClient(createJsonFileSerializer(ctx.dagPath));
  const dag = await client.load();

  // DRIFT-2: no dag.milestone_add/dag.operation_add MCP tools exist
  // (tools-mcp is deferred) — author directly through the real DagClient.
  dag.milestones = {
    research: makeMilestone({
      description: 'Research embedding model options for the notes app and summarize tradeoffs.',
      agent: 'e2e-research-agent',
      depends_on: [],
      guard: PASS_GUARD,
    }),
    interface: makeMilestone({
      description: 'Design the public TypeScript interface for the embedding client.',
      agent: 'e2e-interface-agent',
      depends_on: ['research'],
      guard: PASS_GUARD,
    }),
    implement: makeMilestone({
      description: 'Implement the embedding client against the agreed interface.',
      agent: 'e2e-implement-agent',
      depends_on: ['interface'],
      guard: markerGuard(ctx.markerPath),
    }),
  };
  dag.operations = [
    makeOp('research.1', 'research', []),
    makeOp('research.2', 'research', ['research.1']),
    makeOp('interface.1', 'interface', []),
    makeOp('interface.2', 'interface', ['interface.1']),
    makeOp('implement.1', 'implement', []),
  ];
  dag.providers = { Sonnet: makeProviderConfig() };
  dag.effort_max_tokens = { medium: 4096 };
  dag.terminal = 'implement';

  await client.saveDag(dag);

  const validateRes = runCli(['validate', '--dag-path', ctx.dagPath]);
  assert(validateRes.status === 0, `validate exit ${validateRes.status}: ${validateRes.stderr}`);
  const validation = JSON.parse(validateRes.stdout.trim()) as ValidationResult;
  assert(validation.valid === true, `expected a structurally-valid dag, got errors: ${JSON.stringify(validation.errors)}`);
  assertEqual(validation.errors, [], 'validation errors (cycle-free, no orphans)');

  const statusRes = runCli(['status', '--dag-path', ctx.dagPath]);
  assert(statusRes.status === 0, `status exit ${statusRes.status}: ${statusRes.stderr}`);
  const statusJson = JSON.parse(statusRes.stdout.trim()) as Record<string, { status: string }>;
  assertEqual(Object.keys(statusJson).sort(), ['implement', 'interface', 'research'], 'status milestone keys');
  assertEqual(statusJson['research']?.status, 'pending', 'research status');

  const eligibleRes = runCli(['eligible', '--dag-path', ctx.dagPath]);
  assert(eligibleRes.status === 0, `eligible exit ${eligibleRes.status}: ${eligibleRes.stderr}`);
  assertEqual(JSON.parse(eligibleRes.stdout.trim()), ['research'], 'eligible milestones after authoring');

  // The on-disk file itself, re-read fresh and re-validated — proves the
  // write is really what bin/cli.ts's own read just proved, from a second,
  // independent code path.
  const onDisk = JSON.parse(fs.readFileSync(ctx.dagPath, 'utf8')) as unknown;
  assert(typeof onDisk === 'object' && onDisk !== null, 'on-disk dag.json must parse as an object');

  return (
    '3 milestones (research -> interface -> implement) + 5 ops authored via the real DagClient ' +
    "(DRIFT-2: no dag.milestone_add/dag.operation_add MCP tools exist yet); " +
    `validate={valid:true,errors:[]}; status keys=[implement,interface,research]; eligible=['research']`
  );
}

// ---------------------------------------------------------------------------
// ── Scenario 3 — Snapshot + optimize ─────────────────────────────────────────
// ---------------------------------------------------------------------------

async function scenario3(ctx: LifecycleCtx): Promise<string> {
  const optimizeRes = runCli(['optimize', '--dag-path', ctx.dagPath]);
  assert(optimizeRes.status === 0, `optimize exit ${optimizeRes.status}: ${optimizeRes.stderr}`);
  const units = JSON.parse(optimizeRes.stdout.trim()) as DispatchUnit[];
  assert(units.length === 1, `expected exactly 1 DispatchUnit (only 'research' eligible), got ${units.length}`);
  const unit = units[0];
  assert(unit !== undefined, 'units[0] must exist');
  assertEqual(unit.milestones, ['research'], 'packed milestones');
  assert(unit.fits_context_window === true, `fits_context_window must be true, got ${unit.fits_context_window}`);

  // DRIFT-3: SentinelRole is 'prewarm' | 'payload' only — 'solo' is not a
  // member of the real type. optimize() always emits null (sentinel-fanout
  // role assignment is deferred).
  assert(unit.sentinel_role === null, `DRIFT-3: expected sentinel_role null, got ${JSON.stringify(unit.sentinel_role)}`);

  assert(
    typeof unit.tokens_estimated === 'number' && Number.isInteger(unit.tokens_estimated) && unit.tokens_estimated > 0,
    `tokens_estimated must be a positive integer (B cold-start seeded), got ${unit.tokens_estimated}`
  );

  // DRIFT-6: "all 3 milestone descriptions and all 5 op specs" is impossible
  // given the chained depends_on authored in scenario 2 — only 'research' is
  // eligible right now, so the real compiled prompt can only ever contain
  // research's description + its own 2 ops.
  const prompt = unit.prompt ?? '';
  assert(prompt.includes('## Milestone: research'), 'prompt must contain the research milestone header');
  assert(
    prompt.includes('Research embedding model options'),
    'prompt must contain the research milestone description text'
  );
  assert(prompt.includes('research.1'), 'prompt must contain op research.1');
  assert(prompt.includes('research.2'), 'prompt must contain op research.2');
  assert(
    !prompt.includes('## Milestone: interface') && !prompt.includes('## Milestone: implement'),
    'DRIFT-6: prompt must NOT contain interface/implement (not yet eligible) — proves the "all 3/5" narrative is unachievable by design'
  );

  return (
    "optimize() packed exactly 1 unit for 'research' (interface/implement correctly excluded by the depends_on chain); " +
    `fits_context_window=true; sentinel_role=null (DRIFT-3); tokens_estimated=${unit.tokens_estimated} (positive int); ` +
    'prompt scoped to only the eligible milestone (DRIFT-6, documented — "all 3/5" is impossible given the chain)'
  );
}

// ---------------------------------------------------------------------------
// ── Scenario 4 — Dispatch via orchestrator (MockAgentRunner) ────────────────
// ---------------------------------------------------------------------------

async function scenario4(ctx: LifecycleCtx): Promise<string> {
  ctx.runner = new MockAgentRunner({ debugDir: path.join(ctx.dir, 'mock-debug') });
  ctx.deps = createTestOrchestrator(ctx.dagPath, ctx.runner, 'e2e-dispatch');

  const result = await orchestrateCycle(ctx.deps);
  assert(result.terminal === false, `expected a non-terminal cycle, got terminal=${result.terminal} reason=${result.terminalReason}`);
  assert(result.persisted === true, 'expected the cycle to persist');
  assert(result.dispatched.length === 1, `expected 1 dispatched unit, got ${result.dispatched.length}`);
  const dispatched = result.dispatched[0];
  assert(dispatched !== undefined, 'dispatched[0] must exist');
  assertEqual(dispatched.milestones, ['research'], 'dispatched milestones');
  assertEqual(dispatched.taskStatus, 'completed', 'task status');

  const reloaded = await readDagOnDisk(ctx.dagPath);
  assert(reloaded.dispatch_log.length === 1, `expected 1 dispatch_log entry, got ${reloaded.dispatch_log.length}`);
  const entry = reloaded.dispatch_log[0];
  assert(entry !== undefined, 'dispatch_log[0] must exist');
  assertEqual(entry.kind, 'execution', 'dispatch_log entry kind');
  assert(entry.turns.length === 1, `expected 1 synthesized turn, got ${entry.turns.length}`);
  const turn = entry.turns[0];
  assert(turn !== undefined, 'turns[0] must exist');
  assert(
    typeof turn.model_calls === 'number' && turn.model_calls > 0,
    `turn must carry model_calls (DEBT-DISPATCH-008), got ${turn.model_calls}`
  );

  const snap = snapshot(reloaded, { bPerTier: DEFAULT_B_PER_TIER, contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER });
  assertEqual(snap.milestones['research']?.status, 'complete', 'research status after dispatch');

  // DRIFT-7: eligible stays true post-completion by design (D-07 never
  // consults a milestone's own status). The real "won't be re-dispatched"
  // signal is optimize()'s candidate list, not the raw eligible boolean.
  assert(
    snap.milestones['research']?.eligible === true,
    `DRIFT-7: eligible must stay true post-completion, got ${snap.milestones['research']?.eligible}`
  );
  const nextUnits = optimize(snap, { bPerTier: DEFAULT_B_PER_TIER, contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER });
  assert(
    !nextUnits.some((u) => u.milestones.includes('research')),
    "research must be absent from a fresh optimize() call now that its status is no longer 'pending'"
  );

  return (
    "orchestrateCycle dispatched 'research' via MockAgentRunner; dispatch_log[0] recorded with a synthesized turn " +
    `(model_calls=${turn.model_calls}); research.status=complete; DRIFT-7 documented (eligible stays true; ` +
    'optimize() candidate list — confirmed absent — is the real "done" signal)'
  );
}

// ---------------------------------------------------------------------------
// ── Scenario 5 — Second cycle (interface) ────────────────────────────────────
// ---------------------------------------------------------------------------

async function scenario5(ctx: LifecycleCtx): Promise<string> {
  const result = await orchestrateCycle(ctx.deps);
  assert(result.terminal === false, `expected a non-terminal cycle, got reason=${result.terminalReason}`);
  const dispatched = result.dispatched[0];
  assert(dispatched !== undefined, 'dispatched[0] must exist');
  assertEqual(dispatched.milestones, ['interface'], 'dispatched milestones (cycle 2)');
  assertEqual(dispatched.taskStatus, 'completed', 'task status');

  const reloaded = await readDagOnDisk(ctx.dagPath);
  assert(reloaded.dispatch_log.length === 2, `expected 2 dispatch_log entries, got ${reloaded.dispatch_log.length}`);
  const interfaceEntry = reloaded.dispatch_log[1];
  assert(interfaceEntry !== undefined, 'dispatch_log[1] must exist');
  const guardResult = interfaceEntry.results.find((r) => r.op_id === 'interface.guard');
  assertEqual(guardResult?.guard_result, 'pass', 'interface guard result');

  const snap = snapshot(reloaded, { bPerTier: DEFAULT_B_PER_TIER, contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER });
  const statuses = [
    snap.milestones['research']?.status,
    snap.milestones['interface']?.status,
    snap.milestones['implement']?.status,
  ];
  assertEqual(statuses, ['complete', 'complete', 'pending'], 'milestone statuses after cycle 2 (2 complete, 1 pending)');
  assert(snap.milestones['implement']?.eligible === true, 'implement should now be eligible (interface complete)');

  return (
    "cycle 2 dispatched 'interface' (guard pass); dispatch_log now has 2 entries; " +
    'statuses = 2 complete (research, interface), 1 pending (implement — now eligible, interface satisfied)'
  );
}

// ---------------------------------------------------------------------------
// ── Scenario 6 — Guard failure -> correction injected ────────────────────────
// ---------------------------------------------------------------------------

async function scenario6(ctx: LifecycleCtx): Promise<string> {
  const result = await orchestrateCycle(ctx.deps);
  assert(result.terminal === false, `expected a non-terminal cycle, got reason=${result.terminalReason}`);
  const dispatched = result.dispatched[0];
  assert(dispatched !== undefined, 'dispatched[0] must exist');
  assertEqual(dispatched.milestones, ['implement'], 'dispatched milestones (cycle 3)');
  assert(
    result.injectedMilestones.length === 1,
    `expected exactly 1 injected correction, got ${JSON.stringify(result.injectedMilestones)}`
  );
  const correctionSlug = result.injectedMilestones[0];
  assert(correctionSlug !== undefined, 'injectedMilestones[0] must exist');
  ctx.correctionSlug = correctionSlug;
  assertEqual(ctx.correctionSlug, 'implement-correction-1', 'injected correction slug');

  const guardOutcome = dispatched.guardOutcomes.find((g) => g.milestone === 'implement');
  assertEqual(guardOutcome?.guardResult, 'fail', 'implement guard result (first attempt)');
  assertEqual(guardOutcome?.injectedCorrection, 'implement-correction-1', 'guardOutcome.injectedCorrection');

  ctx.failingDispatchId = dispatched.dispatchLogEntryId;

  const reloaded = await readDagOnDisk(ctx.dagPath);
  assert(reloaded.dispatch_log.length === 3, `expected 3 dispatch_log entries, got ${reloaded.dispatch_log.length}`);
  const correction = reloaded.milestones['implement-correction-1'];
  assert(correction !== undefined, 'implement-correction-1 milestone must exist on disk');
  assertEqual(correction.triggered_by, ctx.failingDispatchId, 'correction.triggered_by must equal the failing dispatch id');
  assertEqual(correction.pending, null, 'correction.pending');
  assertEqual(correction.depends_on, ['interface'], "correction.depends_on copied from the original milestone's");
  assertEqual(correction.agent, 'e2e-implement-agent', "correction.agent copied from the original milestone's");
  assertEqual(fs.existsSync(ctx.markerPath), true, 'marker file must have been created by the first (failing) guard run');

  const snap = snapshot(reloaded, { bPerTier: DEFAULT_B_PER_TIER, contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER });
  assertEqual(snap.milestones['implement']?.status, 'failed', 'implement status after guard failure');
  assertEqual(snap.milestones['implement-correction-1']?.status, 'pending', 'correction status');
  assertEqual(snap.milestones['implement-correction-1']?.eligible, true, 'correction eligible');

  // DRIFT-4: real behavior, not the milestone's "pending-surfaced" / "review
  // milestone" / open_questions narrative — see the file header.
  assert(
    reloaded.milestones['implement']?.pending === null,
    'DRIFT-4: guard failure never sets .pending on the original milestone'
  );
  const openQ = snap.open_questions.find((q) => q.blocking === 'implement' || q.blocking === 'implement-correction-1');
  assert(
    openQ === undefined,
    'DRIFT-4: guard-failure correction injection produces NO open_questions entry (documented deviation from the milestone narrative)'
  );

  return (
    "cycle 3 dispatched 'implement': guard failed (marker created), correction 'implement-correction-1' injected " +
    `with triggered_by=${ctx.failingDispatchId}; implement.status=failed, correction eligible=true; ` +
    'DRIFT-4 documented (no open_questions/"review" milestone in real behavior — matches orchestrator.spec.ts)'
  );
}

// ---------------------------------------------------------------------------
// ── Scenario 7 — Correction resolves and retry succeeds ──────────────────────
// ---------------------------------------------------------------------------

async function scenario7(ctx: LifecycleCtx): Promise<string> {
  const result = await orchestrateCycle(ctx.deps);
  assert(result.terminal === false, `expected a non-terminal cycle, got reason=${result.terminalReason}`);
  const dispatched = result.dispatched[0];
  assert(dispatched !== undefined, 'dispatched[0] must exist');
  assertEqual(dispatched.milestones, ['implement-correction-1'], 'dispatched milestones (cycle 4)');
  const guardOutcome = dispatched.guardOutcomes.find((g) => g.milestone === 'implement-correction-1');
  assertEqual(guardOutcome?.guardResult, 'pass', 'implement-correction-1 guard result (retry — marker now exists)');

  const reloaded = await readDagOnDisk(ctx.dagPath);
  assert(reloaded.dispatch_log.length === 4, `expected 4 dispatch_log entries, got ${reloaded.dispatch_log.length}`);

  const totalTokens = reloaded.dispatch_log.reduce(
    (sum, e) => sum + e.turns.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0),
    0
  );
  assert(totalTokens > 0, `expected non-zero total tokens across dispatch_log, got ${totalTokens}`);

  const snap = snapshot(reloaded, { bPerTier: DEFAULT_B_PER_TIER, contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER });
  assertEqual(snap.milestones['implement-correction-1']?.status, 'complete', 'correction status after retry');

  // Confirms (does not newly discover) orchestrator.ts's own disclosed gap:
  // no automatic depends_on rewiring exists, so the ORIGINAL milestone can
  // never automatically become complete again through orchestrateCycle
  // alone. Not a regression in this test — a pinned, already-documented fact.
  assertEqual(
    snap.milestones['implement']?.status,
    'failed',
    'implement remains failed — confirms orchestrator.ts\'s disclosed auto-requeue gap, not a regression here'
  );

  return (
    "cycle 4 dispatched 'implement-correction-1': guard passed (marker existed from cycle 3); " +
    `4 dispatch_log entries total; total tokens=${totalTokens} (non-zero); correction.status=complete. ` +
    "Confirms orchestrator.ts's disclosed gap: 'implement' itself stays 'failed' (no automatic depends_on rewiring yet)"
  );
}

// ---------------------------------------------------------------------------
// ── Scenario 8 — Resume + calibrate ──────────────────────────────────────────
// ---------------------------------------------------------------------------

async function scenario8(ctx: LifecycleCtx): Promise<string> {
  const beforeReload = await readDagOnDisk(ctx.dagPath);
  const dispatchLogLenBefore = beforeReload.dispatch_log.length;

  // Simulate "kill the process, restart": a brand-new runner/deps/client
  // instance reading the SAME on-disk dag.json — nothing carried over in
  // memory from ctx.deps/ctx.runner above.
  const freshRunner = new MockAgentRunner({ debugDir: path.join(ctx.dir, 'mock-debug-resume') });
  const freshDeps = createTestOrchestrator(ctx.dagPath, freshRunner, 'e2e-resume');

  const result = await orchestrateCycle(freshDeps);
  assertEqual(result.terminal, true, 'a fresh process resuming a dag with no eligible+pending work must report terminal');
  assertEqual(result.dispatched, [], 'must not dispatch anything on resume');
  assertEqual(result.persisted, false, 'must not write to disk when nothing was dispatched');
  assertEqual(
    result.terminalReason,
    'no-eligible-work',
    "terminalReason (implement is 'failed', not complete/skipped, so allComplete is false)"
  );
  assertEqual(freshRunner.firedUnits, [], 'the fresh runner must never have fired anything');

  const afterReload = await readDagOnDisk(ctx.dagPath);
  assertEqual(
    afterReload.dispatch_log.length,
    dispatchLogLenBefore,
    'dispatch_log length must be unchanged — no re-dispatch of completed milestones'
  );

  const statusRes = runCli(['status', '--dag-path', ctx.dagPath]);
  assert(statusRes.status === 0, `status exit ${statusRes.status}: ${statusRes.stderr}`);
  const statusJson = JSON.parse(statusRes.stdout.trim()) as Record<string, { status: string }>;
  assertEqual(statusJson['research']?.status, 'complete', 'status(research)');
  assertEqual(statusJson['interface']?.status, 'complete', 'status(interface)');
  assertEqual(statusJson['implement']?.status, 'failed', 'status(implement)');
  assertEqual(statusJson['implement-correction-1']?.status, 'complete', 'status(implement-correction-1)');

  // DRIFT-5: calibrate() is unconditionally a paid boundary. This exercises
  // the real calibrateCore logic + real file I/O with MockAgentRunner and a
  // tmp-scoped path — never the real ~/.adhd/dispatch-calibration.json or a
  // real billed call — matching this package's own core.spec.ts idiom.
  const calibrationPath = path.join(ctx.dir, 'dispatch-calibration.json');
  const calibrateRunner = new MockAgentRunner({
    debugDir: path.join(ctx.dir, 'mock-debug-calibrate'),
    defaultResult: {
      status: 'completed',
      usage: {
        direct: { inputTokens: 42, outputTokens: 8, modelCalls: 1, toolCallCount: 0, latencyMs: 5 },
        subtree: { inputTokens: 42, outputTokens: 8, modelCalls: 1, toolCallCount: 0, latencyMs: 5 },
        taskCount: 1,
      },
    },
  });
  const calResult = await calibrateCore('Sonnet', calibrateRunner, calibrationPath, {
    poll: { intervalMs: 0, timeoutMs: 0 },
    sleep: async () => undefined,
  });
  assertEqual(calResult.modelTier, 'Sonnet', 'calibrate modelTier');
  assert(
    Number.isInteger(calResult.measuredB) && calResult.measuredB > 0,
    `measuredB must be a positive integer, got ${calResult.measuredB}`
  );
  assert(fs.existsSync(calibrationPath), 'calibration file must exist on disk');
  const written = JSON.parse(fs.readFileSync(calibrationPath, 'utf8')) as Record<string, number>;
  assert(
    typeof written['Sonnet'] === 'number' && written['Sonnet'] > 0,
    `calibration file must contain a positive 'Sonnet' key, got ${JSON.stringify(written)}`
  );

  return (
    'fresh orchestrator instance resumed the same dag.json: terminal=true/no-eligible-work, 0 new dispatch_log ' +
    `entries (was ${dispatchLogLenBefore}); CLI status matches (research/interface/implement-correction-1 complete, ` +
    `implement failed); calibrateCore (DRIFT-5: MockAgentRunner + tmp path) wrote Sonnet=${calResult.measuredB} to disk`
  );
}

// ---------------------------------------------------------------------------
// ── Optional live scenario (DISPATCH_E2E_LIVE=1) ────────────────────────────
// ---------------------------------------------------------------------------

async function liveScenario(): Promise<ScenarioResult> {
  const id = 'L';
  const name = 'LIVE (optional): real agent-mcp dispatch';

  if (process.env['DISPATCH_E2E_LIVE'] !== '1') {
    return {
      id,
      name,
      status: 'SKIP',
      required: false,
      detail:
        "DISPATCH_E2E_LIVE not set to '1' — skipped by default (the repo's single legitimate env-gate exception: " +
        'a real, billed third-party model call). Gate approved by named owner pseudosky ' +
        '(skywinstonsk@gmail.com) — see this file\'s header and dispatch-cli/README.md "Live e2e gate". Run with: ' +
        'DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json ' +
        'packages/dispatch/dispatch-cli/src/test/integration/real-e2e.ts',
    };
  }

  console.warn(
    '[real-e2e] DISPATCH_E2E_LIVE=1 — about to fire ONE real, billed agent-mcp dispatch (claudecli provider). ' +
      'This costs real money/quota and requires local `claude auth status` to be configured.'
  );

  const { dir, dagPath } = setupTestEnv('live-scenario4');
  const contextFile = path.join(dir, 'contexts', 'embedding-research.md');
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });
  let runner: AgentMcpRunner | null = null;

  try {
    const dag: DagJson = {
      schema_version: 4,
      plan_kind: 'greenfield',
      description: 'real-e2e LIVE scenario — one real agent-mcp dispatch',
      problem: 'prove the orchestrator-to-agent-mcp boundary works against a real model',
      approach: 'dispatch a single doc-writing milestone through a real claudecli agent',
      executor: 'real-e2e-live',
      phases: ['e2e-live'],
      terminal: 'embedding-research',
      optimization: EMPTY_OPTIMIZATION,
      providers: { Haiku: makeProviderConfig() },
      effort_max_tokens: { low: 2048 },
      milestones: {
        'embedding-research': makeMilestone({
          description: 'Research embedding model options for a note-taking app and write a short recommendation.',
          agent: 'e2e-live-agent',
          depends_on: [],
          guard: `test -f '${contextFile}'`,
          model: 'Haiku',
          effort: 'low',
        }),
      },
      operations: [
        {
          id: 'embedding-research.1',
          milestone: 'embedding-research',
          depends_on: [],
          type: 'generative',
          action: 'create',
          file: contextFile,
          symbol: null,
          provenance: 'manual',
          confidence: 'documented',
          audit_check: null,
          criteria: [],
          tool: null,
          args: null,
          guard: null,
          to_file: null,
          to_symbol: null,
          ki_estimate: 50,
          ki_source: 'estimate',
          authored_by: 'real-e2e-live',
          status: 'pending',
          shape: {
            kind: 'doc',
            description:
              `Use your file-writing tool to create a real file at the absolute path ${contextFile} containing ` +
              'at least one paragraph recommending an embedding model for a note-taking app. Do not just print ' +
              'the content in your response — actually write the file to disk.',
            objective: `The file ${contextFile} exists on disk with real written content.`,
            required_sections: [],
          },
        },
      ],
      dispatch_log: [],
    };
    await createDagClient(createJsonFileSerializer(dagPath)).saveDag(dag);

    runner = new AgentMcpRunner({ command: 'npx', args: ['-y', '@adhd/agent-mcp'] });
    const deps = createTestOrchestrator(dagPath, runner, 'e2e-live');
    // Live model calls are genuinely slow — a generous but still-BOUNDED poll
    // budget (never an unbounded wait).
    deps.poll = { intervalMs: 2000, timeoutMs: 5 * 60 * 1000 };
    deps.sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const result = await orchestrateCycle(deps);
    assert(result.dispatched.length === 1, `expected 1 dispatched unit, got ${result.dispatched.length}`);
    const dispatched = result.dispatched[0];
    assert(dispatched !== undefined, 'dispatched[0] must exist');
    assertEqual(dispatched.taskStatus, 'completed', 'live task status');

    const guardOutcome = dispatched.guardOutcomes.find((g) => g.milestone === 'embedding-research');
    assertEqual(guardOutcome?.guardResult, 'pass', "the dispatched agent's guard command must pass");
    assert(fs.existsSync(contextFile), 'the real agent must have written the context file');

    const reloaded = await readDagOnDisk(dagPath);
    const snap = snapshot(reloaded, { bPerTier: DEFAULT_B_PER_TIER, contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER });
    assertEqual(snap.milestones['embedding-research']?.status, 'complete', 'live milestone status');

    return {
      id,
      name,
      status: 'PASS',
      required: true, // required only once it actually ran (env-gated)
      detail: `real claudecli dispatch completed; guard passed; ${contextFile} written by the real agent (${fs.statSync(contextFile).size} bytes)`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { id, name, status: 'FAIL', required: true, detail };
  } finally {
    if (runner) await runner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ── main ─────────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  const results: ScenarioResult[] = [];
  try {
    const ctx = {} as LifecycleCtx;
    results.push(await runScenario('1', 'Cold start', true, () => scenario1(ctx)));
    results.push(await runScenario('2', 'Author plan', true, () => scenario2(ctx)));
    results.push(await runScenario('3', 'Snapshot + optimize', true, () => scenario3(ctx)));
    results.push(await runScenario('4', 'Dispatch (research)', true, () => scenario4(ctx)));
    results.push(await runScenario('5', 'Cycle 2 (interface)', true, () => scenario5(ctx)));
    results.push(await runScenario('6', 'Guard failure -> correction', true, () => scenario6(ctx)));
    results.push(await runScenario('7', 'Correction retry succeeds', true, () => scenario7(ctx)));
    results.push(await runScenario('8', 'Resume + calibrate', true, () => scenario8(ctx)));
    results.push(await liveScenario());
  } finally {
    printTable(results);
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }

  const requiredFailed = results.some((r) => r.required && r.status === 'FAIL');
  process.exit(requiredFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('[real-e2e] FATAL (unhandled):', err);
  process.exit(1);
});
