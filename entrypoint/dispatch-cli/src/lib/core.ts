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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  DagJson,
  DagSnapshot,
  DispatchUnit,
  IOptimizerDeps,
  MilestoneStatus,
  ModelTier,
  OperationAction,
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
  FS_DESTRUCTIVE_ACTIONS,
  MockAgentRunner,
  orchestrateCycle,
  pollUntilTerminal,
  type CycleResult,
  type IDispatchAgentRunner,
  type IMcpToolClient,
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
 * The most recent HITL suspension recorded for `slug`, if any (03145a46).
 * Scans the dispatch_log for an entry that carries a `suspension` AND touches
 * one of the milestone's own operation ids; the LAST such entry wins (a
 * milestone suspended, resumed, and suspended again reports the live one).
 * Returns `null` when the milestone has never suspended.
 */
function latestSuspensionForMilestone(
  dag: DagJson,
  slug: string,
  ownOps: Map<string, string[]>
): { taskId: string; resumeToken: string } | null {
  const opIds = new Set(ownOps.get(slug) ?? []);
  if (opIds.size === 0) return null;
  let latest: { taskId: string; resumeToken: string } | null = null;
  for (const entry of dag.dispatch_log) {
    if (!entry.suspension) continue;
    if (entry.operations.some((opId) => opIds.has(opId))) {
      latest = entry.suspension;
    }
  }
  return latest;
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
/** How many directory levels to walk up from the entry script looking for the
 *  monorepo's `entrypoint/` directory. Generous enough to cover `src/lib`,
 *  `dist/`, and any build nesting, while bounded. */
const WORKSPACE_MARKER_SEARCH_DEPTH = 12;

/**
 * Base path used both to resolve the installed `@adhd/backlog` package and to
 * walk up to the monorepo root. Deliberately `process.argv[1]` (the entry
 * script) and NEVER `process.cwd()` — the original defect. `argv[1]` is a file
 * inside the running install (`…/entrypoint/dispatch-cli/dist/bin/cli.js` for
 * the published bin, `…/node_modules/vitest/…` under a test runner), so it
 * identifies the tree whose `node_modules` owns the dependencies, and it does
 * not change when a caller `cd`s elsewhere.
 */
function resolutionBase(): string {
  const entry = process.argv[1];
  return entry && entry.length > 0 ? entry : join(process.cwd(), 'index.js');
}

/**
 * Resolve the `@adhd/backlog` MCP-server entry (`dist/index.js`) to an
 * ABSOLUTE path — never a `process.cwd()`-relative guess.
 *
 * The pre-fix default was
 * `join(process.cwd(), 'entrypoint', 'backlog', 'dist', 'index.js')`. That is
 * correct only when the caller happens to run from the monorepo root, and is
 * broken for every out-of-repo consumer (a published/installed
 * `@adhd/dispatch-cli`): their cwd has no `entrypoint/backlog/` at all, so the
 * spawned backlog server silently fails to start. Resolution order:
 *
 *   1. `ADHD_DISPATCH_BACKLOG_MCP_ENTRY` — an explicit override always wins
 *      (used verbatim, so a caller can point at any backlog build).
 *   2. `createRequire(import.meta.url).resolve('@adhd/backlog')` — the
 *      installed package's real entry. This is the correct resolution for a
 *      consumer that has `@adhd/backlog` installed.
 *   3. The monorepo checkout this CLI was launched from — the nearest ancestor
 *      directory containing `entrypoint/`, plus `entrypoint/backlog/dist/
 *      index.js`. Relative to the entry script (see {@link resolutionBase}), so
 *      it is INDEPENDENT of the caller's cwd.
 *
 * @throws when no candidate resolves (no override, `@adhd/backlog` not
 *   installed, and this CLI is not inside the monorepo) — fail loudly rather
 *   than hand the child a path that 404s at spawn time.
 */
export function resolveBacklogMcpEntry(
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env['ADHD_DISPATCH_BACKLOG_MCP_ENTRY'];
  if (override) return override;

  const base = resolutionBase();
  try {
    return createRequire(base).resolve('@adhd/backlog');
  } catch {
    // Not installed as a resolvable dependency — fall through to the
    // monorepo-relative path (the in-repo dev case).
  }

  let dir = dirname(base);
  for (let i = 0; i < WORKSPACE_MARKER_SEARCH_DEPTH; i++) {
    if (existsSync(join(dir, 'entrypoint'))) {
      return join(dir, 'entrypoint', 'backlog', 'dist', 'index.js');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    'defaultDispatchMcpServers: cannot locate the @adhd/backlog MCP server entry. ' +
      'Install @adhd/backlog, or set ADHD_DISPATCH_BACKLOG_MCP_ENTRY to its ' +
      'dist/index.js absolute path.'
  );
}

/**
 * The default `mcpServers` every dispatch-created agent is born with (backlog
 * daafe2d3): the memory-server (so a dispatched agent can recall prior
 * findings) and the backlog MCP server (so it can read/write backlog items) —
 * neither was wired before, so an agent created for dispatch work had no
 * memory or backlog access at all.
 *
 * Wire-shaped (transport-discriminated) — exactly the JSON `agent_create`
 * accepts. Both entries are environment-overridable:
 *   - `ADHD_DISPATCH_MEMORY_MCP_URL`    (default `http://localhost:3099/sse`)
 *   - `ADHD_DISPATCH_BACKLOG_MCP_ENTRY` (override; else resolved by
 *     {@link resolveBacklogMcpEntry} — installed package, then monorepo)
 */
export function defaultDispatchMcpServers(
  env: NodeJS.ProcessEnv = process.env
): Record<string, Record<string, unknown>> {
  const memoryUrl =
    env['ADHD_DISPATCH_MEMORY_MCP_URL'] ?? 'http://localhost:3099/sse';
  const backlogEntry = resolveBacklogMcpEntry(env);

  return {
    'memory-server': { transport: 'sse', url: memoryUrl },
    backlog: {
      transport: 'stdio',
      command: 'node',
      args: [backlogEntry, 'serve', '--transport', 'mcp'],
    },
  };
}

/**
 * Production `AgentMcpRunner` wiring — spawns agent-mcp via `npx -y
 * @adhd/agent-mcp` by default (matching agent-mcp's documented Quickstart).
 *
 * The launch is environment-overridable so a caller (or a hermetic e2e test)
 * can point at a local/alternative agent-mcp build instead of the published
 * one:
 *   - `ADHD_DISPATCH_AGENT_MCP_COMMAND` (default `npx`)
 *   - `ADHD_DISPATCH_AGENT_MCP_ARGS`    (whitespace-separated; default
 *     `-y @adhd/agent-mcp`)
 */
export interface ProductionRunnerOverrides {
  /** Test seam: inject the MCP client instead of spawning `command`/`args`. */
  clientFactory?: () => IMcpToolClient;
  /**
   * No-auto-create override (backlog f1dbd0f2). Defaults to `false` for the
   * dispatch host: a DAG's `agent` field names an operator-owned agent, and a
   * missing one (e.g. a persona since `agent_delete`d) must FAIL the run rather
   * than be silently re-created with an empty/default systemPrompt. `calibrate`
   * opts back in with `true` — it mints a synthetic null-task agent that never
   * pre-exists.
   */
  createAgentsIfMissing?: boolean;
}

export function buildProductionAgentMcpRunner(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ProductionRunnerOverrides = {}
): AgentMcpRunner {
  const command = env['ADHD_DISPATCH_AGENT_MCP_COMMAND'] ?? 'npx';
  const args = env['ADHD_DISPATCH_AGENT_MCP_ARGS']
    ? env['ADHD_DISPATCH_AGENT_MCP_ARGS'].split(/\s+/).filter(Boolean)
    : ['-y', '@adhd/agent-mcp'];
  const requestTimeoutMs = env['ADHD_DISPATCH_AGENT_MCP_REQUEST_TIMEOUT_MS']
    ? Number(env['ADHD_DISPATCH_AGENT_MCP_REQUEST_TIMEOUT_MS'])
    : DEFAULT_POLL.timeoutMs;
  return new AgentMcpRunner({
    command,
    args,
    defaultMcpServers: defaultDispatchMcpServers(env),
    // DAG-named agents must already exist (f1dbd0f2): never silently
    // (re)create a missing/deleted persona. `calibrate` overrides this.
    createAgentsIfMissing: overrides.createAgentsIfMissing ?? false,
    // Align the MCP per-request timeout with the orchestrator poll budget
    // (DEFAULT_POLL) so a synchronous `task` call can never be aborted at the
    // SDK's 60s default before the poll deadline it is paired with — the
    // "60s MCP abort vs Ns poll" mismatch. Sessioned tasks already fire in the
    // background (03145a46); this covers the synchronous ephemeral path too.
    requestTimeoutMs,
    ...(overrides.clientFactory ? { clientFactory: overrides.clientFactory } : {}),
  });
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
  /**
   * Present iff `status === 'awaiting_input'` (03145a46): the suspended
   * agent-mcp task and the opaque `resumeToken` to pass to agent-mcp's
   * `task_resume` to release it. Read from the milestone's most recent
   * dispatch_log entry carrying a `suspension` — so a fresh `dispatch-cli
   * status` process can surface a suspension fired by an earlier process.
   */
  awaitingInput?: { taskId: string; resumeToken: string };
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
    const awaitingInput =
      ms.status === 'awaiting_input'
        ? latestSuspensionForMilestone(dag, slug, ownOps)
        : null;
    report[slug] = {
      status: ms.status,
      loggedOperationIds: (ownOps.get(slug) ?? []).filter((id) => logged.has(id)),
      tokensEstimated: ms.tokens_estimated,
      tokensActual: ms.tokens_actual,
      ...(awaitingInput ? { awaitingInput } : {}),
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
 * @param allowedFsActions - FEAT-DISPATCH-GOVERNANCE-001: comma-parsed
 *   `OperationAction` names (from `--allow-fs`) permitted to actually
 *   execute their `fs.move`/`fs.delete`/`fs.scaffold`/`fs.edit` tool-call op
 *   this cycle. Default: `[]` — every destructive fs op is denied unless
 *   explicitly opted in. Rejects (throws, before ever touching a runner or
 *   the filesystem) any entry that is not one of
 *   `@adhd/dispatch-orchestrator`'s `FS_DESTRUCTIVE_ACTIONS`.
 * @param toolsRoot - BUG-DISPATCH-CLI-TOOLSROOT-001 (found during
 *   FEAT-DISPATCH-GOVERNANCE-001's code review): before this parameter
 *   existed, `runCycleCore` never set `OrchestratorDeps.toolsRoot` at all, so
 *   `@adhd/dispatch-orchestrator`'s `resolveToolPath` fell back to its own
 *   default of `process.cwd()` — wherever the CLI happened to be invoked
 *   from — rather than any path scoped to the plan being run. From
 *   `--tools-root` (`bin/cli.ts`) via `api.ts`'s `run`. Optional; defaults to
 *   `process.cwd()`, matching `@adhd/dispatch-orchestrator`'s own default so
 *   omitting the flag is a no-op change in behavior.
 */
export async function runCycleCore(
  dagPath: string,
  dryRun: boolean,
  runnerOverride?: IDispatchAgentRunner,
  allowedFsActions: string[] = [],
  toolsRoot?: string
): Promise<CycleResult> {
  await guardDagExists(dagPath);
  for (const action of allowedFsActions) {
    if (!FS_DESTRUCTIVE_ACTIONS.has(action as OperationAction)) {
      throw new Error(
        `runCycleCore: unknown --allow-fs action '${action}' — expected one of ` +
          `${[...FS_DESTRUCTIVE_ACTIONS].join(', ')}`
      );
    }
  }
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
    allowedFsActions: allowedFsActions as OperationAction[],
    ...(toolsRoot !== undefined ? { toolsRoot } : {}),
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
