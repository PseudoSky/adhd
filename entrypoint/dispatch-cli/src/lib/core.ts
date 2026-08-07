/**
 * core.ts — the REAL, dependency-injected implementation behind every
 * `../api.ts` command. `api.ts` is apigen's extraction surface (plain,
 * schema-safe function signatures only — no interface-typed params, since
 * ts-json-schema-generator drives the generated CLI's flags from those
 * signatures). This module is where production wiring, injectable seams,
 * and anything worth unit-testing directly (without spawning the generated
 * CLI) actually lives — mirrors the split `@adhd/dispatch-orchestrator`
 * itself uses (a fully-DI'd core + thin default-wired callers).
 *
 * Every function here that touches a paid boundary (`runCycleCore`'s
 * non-dry-run path, `calibrateCore`) takes its runner as a REQUIRED
 * parameter with NO internal fallback — only `api.ts` supplies the real
 * `AgentMcpRunner` + production paths. Tests always inject `MockAgentRunner`
 * and a path under `tmp/dispatch-cli/`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  DagJson,
  DagSnapshot,
  DispatchUnit,
  IOptimizerDeps,
  MilestoneStatus,
  ModelTier,
  OperationDag,
  ValidationResult,
} from '@adhd/dispatch-base-spec';
import { validateDagJson } from '@adhd/dispatch-base-spec';
import { createDagClient, type IDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import {
  optimize as computeOptimize,
  snapshot as computeSnapshot,
} from '@adhd/dispatch-core-optimizer';
import {
  AgentMcpRunner,
  DEFAULT_B_PER_TIER,
  DEFAULT_CONTEXT_WINDOW_PER_TIER,
  DEFAULT_POLL,
  MockAgentRunner,
  orchestrateCycle,
  pollUntilTerminal,
  type CycleResult,
  type IDispatchAgentRunner,
  type OrchestratorDeps,
  type PollConfig,
} from '@adhd/dispatch-orchestrator';

// ---------------------------------------------------------------------------
// ── Shared helpers ───────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** Builds a real `IDagClient` reading/writing `dagPath` via the JSON-file serializer. */
export function buildClient(dagPath: string): IDagClient {
  return createDagClient(createJsonFileSerializer(dagPath));
}

/** Throws if `dagPath` does not point to a readable dag file, with the path in the message. */
async function guardDagExists(dagPath: string): Promise<void> {
  const serializer = createJsonFileSerializer(dagPath);
  const dag = await serializer.readDag();
  if (dag === null) {
    throw new Error(`dag file not found: ${dagPath}`);
  }
}

/**
 * Cold-start `IOptimizerDeps` — sourced from `@adhd/dispatch-orchestrator`'s
 * own `DEFAULT_B_PER_TIER`/`DEFAULT_CONTEXT_WINDOW_PER_TIER` (imported, never
 * duplicated) so every command in this package agrees with the orchestrator
 * on what "uncalibrated" means.
 */
function buildOptimizerDeps(): IOptimizerDeps {
  return {
    bPerTier: DEFAULT_B_PER_TIER,
    contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER,
  };
}

/** Every operation id owned by each milestone, keyed by milestone slug. */
function operationIdsByMilestone(dag: DagJson): Map<string, string[]> {
  const byMilestone = new Map<string, string[]>();
  // DagClient.load() always normalizes `operations` to array form before
  // returning — see DagClient's own internal methods (getOperation,
  // updateOperationStatus), which perform this exact cast without
  // re-normalizing. `dag` here always comes from `buildClient().load()`.
  for (const op of dag.operations as OperationDag[]) {
    const list = byMilestone.get(op.milestone) ?? [];
    list.push(op.id);
    byMilestone.set(op.milestone, list);
  }
  return byMilestone;
}

/** Every operation id that appears in at least one `dispatch_log` entry's `results[]`. */
function loggedOperationIds(dag: DagJson): Set<string> {
  const logged = new Set<string>();
  for (const entry of dag.dispatch_log) {
    for (const result of entry.results) logged.add(result.op_id);
  }
  return logged;
}

/**
 * Production `AgentMcpRunner` wiring — matches agent-mcp's own documented
 * Quickstart invocation (packages/ai/agent-mcp/README.md): spawn the
 * published server via `npx -y @adhd/agent-mcp`.
 *
 * THIS IS A PAID BOUNDARY: every call made through the resulting runner
 * fires a real, billed model call. Used only by `api.ts`'s `run()` (when
 * `dryRun: false`) and `calibrate()` — never by this package's tests.
 */
export function buildProductionAgentMcpRunner(): AgentMcpRunner {
  return new AgentMcpRunner({ command: 'npx', args: ['-y', '@adhd/agent-mcp'] });
}

// ---------------------------------------------------------------------------
// ── validate ─────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** Reads `dagPath` via the JSON-file serializer and runs `validateDagJson` over it. */
export async function validateCore(dagPath: string): Promise<ValidationResult> {
  const serializer = createJsonFileSerializer(dagPath);
  const dag = await serializer.readDag();
  if (dag === null) {
    return {
      valid: false,
      errors: [{ path: '', message: `dag file not found: ${dagPath}` }],
    };
  }
  return validateDagJson(dag);
}

// ---------------------------------------------------------------------------
// ── snapshot / optimize / eligible ──────────────────────────────────────────
// ---------------------------------------------------------------------------

/** Real `DagClient` load + `@adhd/dispatch-core-optimizer`'s `snapshot()`. Read-only. */
export async function snapshotCore(dagPath: string): Promise<DagSnapshot> {
  await guardDagExists(dagPath);
  const dag = await buildClient(dagPath).load();
  return computeSnapshot(dag, buildOptimizerDeps());
}

/** `snapshotCore()` + the greedy `optimize()`. Read-only — dispatches nothing. */
export async function optimizeCore(dagPath: string): Promise<DispatchUnit[]> {
  await guardDagExists(dagPath);
  const dag = await buildClient(dagPath).load();
  const deps = buildOptimizerDeps();
  return computeOptimize(computeSnapshot(dag, deps), deps);
}

/** `DagClient.getEligibleMilestones()` — dispatch_log-derived completion. Read-only. */
export async function eligibleCore(dagPath: string): Promise<string[]> {
  await guardDagExists(dagPath);
  return buildClient(dagPath).getEligibleMilestones();
}

// ---------------------------------------------------------------------------
// ── status ───────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface MilestoneStatusEntry {
  /** The snapshot-derived status — composition, not reimplementation (see snapshotCore). */
  status: MilestoneStatus;
  /** This milestone's own operation ids that have at least one recorded dispatch_log result. */
  loggedOperationIds: string[];
  tokensEstimated: number | null;
  tokensActual: number | null;
}

/**
 * Per-milestone status report: `status`/`tokensEstimated`/`tokensActual` are
 * carried straight from the current `DagSnapshot` (never recomputed —
 * `@adhd/dispatch-core-optimizer`'s `snapshot()` is the single source of truth for
 * completion semantics); `loggedOperationIds` is derived locally from
 * `dag.operations` + `dag.dispatch_log`, the one piece `MilestoneSnapshot`
 * doesn't already carry. Read-only.
 */
export async function statusCore(
  dagPath: string
): Promise<Record<string, MilestoneStatusEntry>> {
  await guardDagExists(dagPath);
  const dag = await buildClient(dagPath).load();
  const snap = computeSnapshot(dag, buildOptimizerDeps());
  const ownOps = operationIdsByMilestone(dag);
  const logged = loggedOperationIds(dag);

  const report: Record<string, MilestoneStatusEntry> = {};
  for (const [slug, ms] of Object.entries(snap.milestones)) {
    report[slug] = {
      status: ms.status,
      loggedOperationIds: (ownOps.get(slug) ?? []).filter((id) => logged.has(id)),
      tokensEstimated: ms.tokens_estimated,
      tokensActual: ms.tokens_actual,
    };
  }
  return report;
}

// ---------------------------------------------------------------------------
// ── run (one orchestrator cycle) ─────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * dispatch-cli's own tmp namespace for `MockAgentRunner`'s debug output
 * (CLAUDE.md "Test/ephemeral artifacts" — one canonical `tmp/<package>/…`
 * root; the orchestrator package's own default,
 * `tmp/dispatch-orchestrator/mock-debug`, is a DIFFERENT package's
 * namespace and would scatter a dry-run's debug artifacts across packages).
 * Exported so tests can assert the default wiring ran, and clean up after it.
 */
export const DEFAULT_RUN_DEBUG_DIR = join(process.cwd(), 'tmp', 'dispatch-cli', 'run-debug');

/**
 * Runs exactly one `@adhd/dispatch-orchestrator` scheduling cycle against
 * `dagPath`.
 *
 * @param dryRun - `true` → a fresh `MockAgentRunner` (safe default; writes
 *   its inspectable debug artifacts under `DEFAULT_RUN_DEBUG_DIR`). `false`
 *   → `buildProductionAgentMcpRunner()` — THE PAID BOUNDARY.
 * @param runnerOverride - Test-only seam: when supplied, wins over `dryRun`
 *   entirely (lets a test inject its own `MockAgentRunner` instance — e.g.
 *   scoped to a test-local debug dir — and inspect `firedUnits`/
 *   `ensureAgentCalls` afterwards). Never supplied by `api.ts`.
 */
export async function runCycleCore(
  dagPath: string,
  dryRun: boolean,
  runnerOverride?: IDispatchAgentRunner
): Promise<CycleResult> {
  await guardDagExists(dagPath);
  const runner =
    runnerOverride ??
    (dryRun
      ? new MockAgentRunner({ debugDir: DEFAULT_RUN_DEBUG_DIR })
      : buildProductionAgentMcpRunner());

  const deps: OrchestratorDeps = {
    client: buildClient(dagPath),
    optimizer: { snapshot: computeSnapshot, optimize: computeOptimize },
    runner,
    bPerTier: DEFAULT_B_PER_TIER,
    contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER,
  };
  return orchestrateCycle(deps);
}

// ---------------------------------------------------------------------------
// ── calibrate ────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

const VALID_MODEL_TIERS: readonly ModelTier[] = ['Haiku', 'Sonnet', 'Opus'];

/** Validates a plain string against `ModelTier`'s three allowed values, throwing a clear error otherwise. */
export function assertModelTier(modelTier: string): ModelTier {
  if ((VALID_MODEL_TIERS as readonly string[]).includes(modelTier)) {
    return modelTier as ModelTier;
  }
  throw new Error(
    `calibrate: unknown modelTier '${modelTier}' — expected one of ${VALID_MODEL_TIERS.join(', ')}`
  );
}

/**
 * Production calibration-store path (SCOPE.md §C4 / §Open Decisions #2, and
 * `@adhd/dispatch-orchestrator`'s `ICalibrationPlaceholder` doc comment,
 * which names this exact path as the future B-calibration store).
 */
export const DEFAULT_CALIBRATION_PATH = join(homedir(), '.adhd', 'dispatch-calibration.json');

export interface CalibrationResult {
  modelTier: ModelTier;
  /** input + output tokens of the null-task turn — the measured baseline "B" for this tier. */
  measuredB: number;
  inputTokens: number;
  outputTokens: number;
  writtenTo: string;
}

const NULL_TASK_PROMPT = 'Respond with only the word "ok". Take no other action.';

function buildNullTaskUnit(modelTier: ModelTier): DispatchUnit {
  const now = new Date().toISOString();
  return {
    id: `dispatch-cli-calibration-${modelTier.toLowerCase()}-${Date.now()}`,
    milestones: [],
    operations: [],
    model: modelTier,
    effort: 'low',
    two_stage: false,
    provider: null,
    agent_name: `dispatch-cli-calibration-${modelTier.toLowerCase()}`,
    execution_mode: 'model-dispatch',
    mcp_servers: {},
    resolved_max_tokens: null,
    background: true,
    systemPrompt: null,
    prompt: NULL_TASK_PROMPT,
    context_files: [],
    si_bytes: 0,
    tokens_estimated: null,
    fits_context_window: true,
    sentinel_role: null,
    dispatch_log_id: null,
    remote_task_id: null,
    result: null,
    status: 'pending',
    started_at: now,
    completed_at: null,
    tokens_actual: null,
  };
}

function readExistingCalibration(outputPath: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // missing file, unreadable, or malformed JSON — start fresh.
  }
  return {};
}

/**
 * Fires a trivial "null task" (a minimal, side-effect-free prompt) against
 * `runner` to measure a baseline per-tier token cost ("B"), then merges the
 * result into the JSON calibration store at `outputPath` (keyed by model
 * tier, preserving any other tiers already recorded there) and returns the
 * measurement.
 *
 * `runner` and `outputPath` are REQUIRED parameters with NO internal
 * fallback — `calibrate()` (the apigen-extracted, CLI-facing wrapper in
 * `../api.ts`) is the only caller that supplies the real `AgentMcpRunner` +
 * `DEFAULT_CALIBRATION_PATH` (a real, billed model call + a write under the
 * user's home directory). Tests call this function directly with a
 * `MockAgentRunner` and a path under `tmp/dispatch-cli/` — never the
 * production defaults.
 */
export async function calibrateCore(
  modelTier: string,
  runner: IDispatchAgentRunner | (() => IDispatchAgentRunner),
  outputPath: string,
  pollOverrides?: { poll?: PollConfig; sleep?: (ms: number) => Promise<void> }
): Promise<CalibrationResult> {
  const tier = assertModelTier(modelTier);
  const resolvedRunner = typeof runner === 'function' ? runner() : runner;
  const poll = pollOverrides?.poll ?? DEFAULT_POLL;
  const sleep =
    pollOverrides?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const unit = buildNullTaskUnit(tier);
  await resolvedRunner.ensureAgent(unit);
  const fired = await resolvedRunner.fire(unit);
  const { usage } = await pollUntilTerminal(resolvedRunner, fired.taskId, poll, sleep);

  const inputTokens = usage?.direct.inputTokens ?? 0;
  const outputTokens = usage?.direct.outputTokens ?? 0;
  const measuredB = inputTokens + outputTokens;

  const existing = readExistingCalibration(outputPath);
  existing[tier] = measuredB;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

  return { modelTier: tier, measuredB, inputTokens, outputTokens, writtenTo: outputPath };
}
