/**
 * orchestrator.ts — the MINIMAL dispatch loop for @adhd/dispatch-orchestrator.
 *
 * One scheduling cycle (`orchestrateCycle`): load dag.json -> optimizer.snapshot()
 * -> optimizer.optimize() -> for each DispatchUnit: resolve provider/max_tokens ->
 * runner.ensureAgent -> runner.fire -> poll until terminal (bounded deadline) ->
 * run every packed milestone's guard (shell exec) -> append ONE dispatch_log entry
 * (turns + op results + guard results) -> persist dag. `orchestrate()` repeats
 * `orchestrateCycle()` until a cycle reports `terminal: true`.
 *
 * See docs/plan/dispatch-completion/superseded/dispatch-production/dag.json milestones["orchestrator-core"],
 * docs/plan/dispatch-completion/superseded/dispatch-optimizer/{SCOPE.md,DECISIONS.md,WORKFLOW.md}, and
 * packages/ai/agent-mcp/README.md for the design this composes.
 *
 * COMPOSITION, NOT REIMPLEMENTATION — eligibility/completion semantics belong
 * entirely to @adhd/dispatch-core-optimizer's `snapshot()`/`optimize()` (D-07,
 * SCOPE.md §N1 step 4 `deriveMilestoneStatus`, §N2 step 1
 * `selectPackableMilestones`) and to @adhd/dispatch-core-client's `DagClient`. This
 * module's only job is to drive real dispatch (agent-mcp via
 * `IDispatchAgentRunner`) and real guard verification, then write results back
 * into the exact shape those two already understand: a milestone becomes
 * "complete" purely because this module appended a passing
 * `{ op_id: "<slug>.guard", guard_result: "pass" }` `DispatchResult` to
 * `dispatch_log` (see snapshot.ts `synthesizeGuardOp`/`deriveMilestoneStatus`).
 * That is also what makes RESUMPTION free: reload dag.json, re-snapshot, and
 * `optimize()`'s `status === 'pending'` filter (optimize.ts
 * `selectPackableMilestones`) naturally excludes anything already marked
 * complete/failed — no bespoke "already done" bookkeeping lives in this file.
 */

import { randomUUID } from 'node:crypto';
import { exec as execCallback } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';

import type {
  DagJson,
  DagSnapshot,
  DispatchLogEntry,
  DispatchNote,
  DispatchResult,
  DispatchUnit,
  GuardResult,
  IOptimizerDeps,
  MilestoneDag,
  OperationDag,
  OperationStatus,
  Turn,
} from '@adhd/dispatch-base-spec';
import type { IDagClient } from '@adhd/dispatch-core-client';

import type {
  DispatchTaskStatus,
  DispatchUsageReport,
  IDispatchAgentRunner,
  SynthesizedTurn,
} from './agent-runner.js';
import { usageToTurns } from './agent-runner.js';

// ---------------------------------------------------------------------------
// ── DETERMINISM SEAMS ────────────────────────────────────────────────────────
// Every seam below is injectable with a production default, and every default
// is pure/deterministic-shaped so tests can swap in a fixed clock, a
// zero-delay sleep, and a scripted guardExec — no wall-clock waits or
// Date.now() assertions anywhere in this module's own logic.
// ---------------------------------------------------------------------------

/** Injectable ISO-8601 clock. Production default: `() => new Date().toISOString()`. */
export type ClockFn = () => string;

/** Injectable dispatch_log entry id factory. Production default: `crypto.randomUUID()`. */
export type IdFactoryFn = () => string;

/** Injectable delay used between polls. Production default: real `setTimeout`. */
export type SleepFn = (ms: number) => Promise<void>;

/** Bounded polling configuration for `runner.poll()`. */
export interface PollConfig {
  /** Delay between polls, in ms. */
  intervalMs: number;
  /** Total time budget across all polls before giving up, in ms. */
  timeoutMs: number;
}

/** Result of running a milestone's `guard` command. */
export interface GuardExecResult {
  /** Process exit code; `null` if the process was killed by a signal (e.g. on timeout). */
  exitCode: number | null;
  /** Combined stdout+stderr, already capped — see `GUARD_OUTPUT_CAP_BYTES`. */
  output: string;
}

/** Injectable guard-command executor. Production default: `node:child_process` `exec`. */
export type GuardExecFn = (
  command: string,
  timeoutMs: number
) => Promise<GuardExecResult>;

/**
 * Real outcome of executing a single `type: "tool-call"` operation (see
 * `ToolCallExecFn`). `result` is the handler's own return payload on success;
 * `error` is a human-readable message on failure. Never a bare boolean —
 * every outcome carries enough payload to become `DispatchResult.tool_result`
 * verbatim.
 */
export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Injectable tool-call executor — the seam BUG-DISPATCH-EXEC-001 fixes.
 * Production default: `defaultToolCallExec` (real in-process execution of the
 * D-13/D-18 dag-mutation + fs verbs). Tests can inject a scripted double for
 * deterministic failure-path coverage without touching the real filesystem.
 */
export type ToolCallExecFn = (
  op: OperationDag,
  dag: DagJson
) => Promise<ToolCallResult> | ToolCallResult;

// ---------------------------------------------------------------------------
// ── OPTIONAL / FUTURE-FACING SEAMS ───────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * `plugins.io` — optional file-system enrichment forwarded into
 * `IOptimizerDeps.fileSizes`/`.readFiles`. Omitting it is the documented fast
 * path: `snapshot()` degrades gracefully (si_bytes stays 0; tokens_estimated
 * still computes from ki_estimate + b_eff alone).
 */
export interface IOrchestratorIoPlugin {
  fileSizes?(paths: string[]): Map<string, number>;
  readFiles?(paths: string[]): Map<string, string>;
}

/**
 * `plugins.gitnexus` — reserved for future wiring. As of this milestone,
 * @adhd/dispatch-core-optimizer's `snapshot()` has NO parameter that consumes a
 * gitnexus signal: `blast_radius`, `conflict`, and shape-op
 * `from`/`breaking`/`severity` are internal TODO stubs hardcoded inside
 * snapshot.ts (not threaded through `IOptimizerDeps`). This field exists only
 * so `OrchestratorDeps`'s shape doesn't need a breaking change once a real
 * seam is added — it is accepted here but never read. Flagged in the
 * orchestrator-core completion report.
 */
export type IOrchestratorGitnexusPlugin = Record<string, unknown>;

/**
 * Placeholder for the future B-calibration store (SCOPE.md §C4 / §Open
 * Decisions #2 — `~/.adhd/dispatch-calibration.json`). No `ICalibrationStore`
 * export exists in `@adhd/dispatch-base-spec` today (verified absent). Deliberately
 * minimal per orchestrator-core's brief ("do NOT invent a rich interface"):
 * read-only access to whatever calibrated per-tier B values a future
 * calibration utility has persisted. Unused by the fast path —
 * `OrchestratorDeps.bPerTier` (cold-start defaults) is what actually feeds
 * `IOptimizerDeps.bPerTier` today. Flagged in the completion report for
 * dispatch-spec to formalize.
 */
export interface ICalibrationPlaceholder {
  read(): Promise<Record<string, number>> | Record<string, number>;
}

// ---------------------------------------------------------------------------
// ── OrchestratorDeps ─────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * The subset of `@adhd/dispatch-core-optimizer`'s surface the orchestrator drives.
 * Injected (rather than imported directly) so this module never depends on
 * `@adhd/dispatch-core-optimizer` at the source level — the fixed pipeline
 * (snapshot -> enrich -> optimize -> dispatch -> poll -> record) stays fully
 * DI-composable, and a caller can inject a fake for pure unit tests of the
 * dispatch/guard/replan machinery without pulling in the real optimizer.
 */
export interface IOptimizerLike {
  snapshot(dag: DagJson, deps: IOptimizerDeps): DagSnapshot;
  optimize(snapshot: DagSnapshot, deps: IOptimizerDeps): DispatchUnit[];
}

export interface OrchestratorDeps {
  /** Loads/saves dag.json. Construct via `createDagClient(createJsonFileSerializer(path))`. */
  client: IDagClient;
  /** Real `{ snapshot, optimize }` from `@adhd/dispatch-core-optimizer`, or a test double. */
  optimizer: IOptimizerLike;
  /** Real `AgentMcpRunner` or `MockAgentRunner` (see `./agent-runner.js`). */
  runner: IDispatchAgentRunner;
  /** OPTIONAL. Both sub-fields optional; the fast path runs with neither. */
  plugins?: {
    io?: IOrchestratorIoPlugin;
    gitnexus?: IOrchestratorGitnexusPlugin;
  };
  /** OPTIONAL. See `ICalibrationPlaceholder`. Not consumed by the fast path. */
  calibration?: ICalibrationPlaceholder;
  /** Cold-start B per tier, fed into `IOptimizerDeps.bPerTier`. Default: `DEFAULT_B_PER_TIER`. */
  bPerTier?: Record<string, number>;
  /** Cold-start context window per tier, fed into `IOptimizerDeps.contextWindowPerTier`. Default: `DEFAULT_CONTEXT_WINDOW_PER_TIER`. */
  contextWindowPerTier?: Record<string, number>;
  /** Default: `() => new Date().toISOString()`. */
  clock?: ClockFn;
  /** Default: `() => randomUUID()`. */
  idFactory?: IdFactoryFn;
  /** Default: real `setTimeout`-based delay. */
  sleep?: SleepFn;
  /** Default: `DEFAULT_POLL`. */
  poll?: Partial<PollConfig>;
  /** Default: spawns `sh -c <guard>` via `node:child_process`. */
  guardExec?: GuardExecFn;
  /** Per-guard timeout, ms. Default: `DEFAULT_GUARD_TIMEOUT_MS` (5 minutes — "generous"). */
  guardTimeoutMs?: number;
  /**
   * Executes `type: "tool-call"` operations for real (BUG-DISPATCH-EXEC-001).
   * Default: `defaultToolCallExec`, scoped to `toolsRoot`.
   */
  toolCallExec?: ToolCallExecFn;
  /**
   * Filesystem root `fs.move`/`fs.delete`/`fs.scaffold` tool-call ops are
   * confined to (paths escaping this root are rejected as a failed outcome,
   * never executed). Default: `process.cwd()`. Only consumed by the default
   * `toolCallExec` — ignored if `toolCallExec` is injected.
   */
  toolsRoot?: string;
  /**
   * Safety cap for `orchestrate()`'s multi-cycle loop only (NOT consumed by
   * `orchestrateCycle()`, which always runs exactly one cycle regardless).
   * Guards against a pathological plan where every injected correction
   * milestone also fails its own guard: `optimize()` always finds the
   * freshly-injected 'pending' milestone eligible next cycle, so `terminal`
   * would otherwise never naturally become true. Default: `DEFAULT_MAX_CYCLES`.
   */
  maxCycles?: number;
  /**
   * When `true` (default), a per-unit transport/disk failure records a
   * `'failed'` dispatch-log entry and continues to the next unit without
   * aborting the cycle. When `false`, the error propagates up immediately.
   */
  continueOnError?: boolean;
}

interface ResolvedDeps {
  client: IDagClient;
  optimizer: IOptimizerLike;
  runner: IDispatchAgentRunner;
  plugins: { io?: IOrchestratorIoPlugin; gitnexus?: IOrchestratorGitnexusPlugin };
  bPerTier: Record<string, number>;
  contextWindowPerTier: Record<string, number>;
  clock: ClockFn;
  idFactory: IdFactoryFn;
  sleep: SleepFn;
  poll: PollConfig;
  guardExec: GuardExecFn;
  guardTimeoutMs: number;
  toolCallExec: ToolCallExecFn;
  continueOnError: boolean;
}

// ---------------------------------------------------------------------------
// ── Defaults ─────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * SCOPE.md §Open Decisions #2 cold-start recommendation. Matches
 * @adhd/dispatch-core-optimizer's own shipped test default
 * (src/test/fixtures.ts `defaultDeps()`) so the two packages agree on what
 * "uncalibrated" means.
 */
export const DEFAULT_B_PER_TIER: Readonly<Record<string, number>> = Object.freeze({
  Haiku: 8000,
  Sonnet: 15000,
  Opus: 27000,
});

/**
 * Full raw per-tier context window. Deliberately more generous than
 * SCOPE.md Part E's 16k/64k "merged-prompt degradation cliff" figures — that
 * number is a quality heuristic, never wired into `optimize()`'s W
 * consumption (`resolveContextWindow` in dispatch-optimizer/src/lib/optimize.ts
 * reads `context_window_per_tier` directly as the hard feasibility ceiling).
 * Matches dispatch-optimizer's own shipped test default.
 */
export const DEFAULT_CONTEXT_WINDOW_PER_TIER: Readonly<Record<string, number>> =
  Object.freeze({
    Haiku: 200000,
    Sonnet: 200000,
    Opus: 200000,
  });

export const DEFAULT_POLL: Readonly<PollConfig> = Object.freeze({
  intervalMs: 2000,
  timeoutMs: 10 * 60 * 1000, // 10 minutes
});

/** "Generous" per the orchestrator-core brief. */
export const DEFAULT_GUARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export const DEFAULT_MAX_CYCLES = 500;

const GUARD_OUTPUT_CAP_BYTES = 8 * 1024;
const GUARD_EXEC_AGENT_LABEL = 'dispatch-orchestrator:guard-exec';

/**
 * Caps `s` at `GUARD_OUTPUT_CAP_BYTES` UTF-8 bytes without splitting a
 * multi-byte character mid-sequence. A naive `buf.toString('utf8', 0, N)`
 * cut can land inside a multi-byte UTF-8 character (e.g. a 3-byte '☃'),
 * which Node's UTF-8 decoder replaces with U+FFFD — corrupting the
 * truncated tail. We back the cut index off while the byte at that offset
 * is a UTF-8 *continuation* byte (top two bits `10`, i.e. `0x80`-`0xBF`);
 * a lead byte (ASCII `0xxxxxxx` or multi-byte lead `11xxxxxx`) is always a
 * safe cut point. See DEBT-DISPATCH-017.
 */
function capOutput(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= GUARD_OUTPUT_CAP_BYTES) return s;
  let cut = GUARD_OUTPUT_CAP_BYTES;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.toString('utf8', 0, cut)}\n...[truncated at ${GUARD_OUTPUT_CAP_BYTES} bytes]`;
}

function defaultClock(): string {
  return new Date().toISOString();
}

function defaultIdFactory(): string {
  return randomUUID();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Production guard executor: `node:child_process.exec`, which already runs
 * `command` via `/bin/sh -c` on POSIX (this package is platform:node — no
 * portability concern). Captures combined stdout+stderr, caps at
 * `GUARD_OUTPUT_CAP_BYTES`, and never rejects — a spawn failure or timeout is
 * reported as a non-zero/`null` exit code with the error folded into
 * `output`, so callers never need a try/catch around this seam.
 */
function defaultGuardExec(
  command: string,
  timeoutMs: number
): Promise<GuardExecResult> {
  return new Promise((resolve) => {
    execCallback(
      command,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const combined = `${stdout}${stderr}`;
        if (!error) {
          resolve({ exitCode: 0, output: capOutput(combined) });
          return;
        }
        const execError = error as NodeJS.ErrnoException & {
          code?: number | string;
          signal?: string;
        };
        const exitCode = typeof execError.code === 'number' ? execError.code : null;
        const timeoutNote =
          execError.signal === 'SIGTERM' ? ', likely exceeded guard timeout' : '';
        const signalNote = execError.signal
          ? ` (killed by ${execError.signal}${timeoutNote})`
          : '';
        const sep = combined === '' || combined.endsWith('\n') ? '' : '\n';
        resolve({
          exitCode,
          output: capOutput(
            `${combined}${sep}[guard exec error${signalNote}: ${error.message}]`
          ),
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// ── Tool-call execution (BUG-DISPATCH-EXEC-001) ─────────────────────────────
//
// `type: "tool-call"` ops (D-13/D-18) were, until this fix, never actually
// executed — the loop below existed only to mark them 'skipped' and warn
// that `@adhd/dispatch-tools` "is not wired in". That package does not exist.
// Rather than fake a fix (still marking 'skipped' but suppressing the
// warning) or boiling the ocean (standing up a whole new publishable MCP
// server package for four dag-mutation verbs the orchestrator already has
// full in-memory access to), this executes the D-13 dag-mutation verbs
// (`dag.set-field`, `dag.clear-pending`, `dag.add-milestone`,
// `dag.append-dispatch-log`) and the D-13 fs verbs (`fs.move`, `fs.delete`,
// `fs.scaffold`) for REAL, in-process — exactly where D-18's `automated`
// actions already run, and exactly what a same-process `@adhd/dispatch-tools`
// client would have had to do anyway (mutate the same `dag: DagJson` this
// module already owns for the whole cycle and persists via `deps.client`).
// Injectable via `ToolCallExecFn` for tests/future real-MCP-server swap-in;
// `defaultToolCallExec` is the production default.
// ---------------------------------------------------------------------------

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required string arg '${key}'`);
  }
  return value;
}

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Minimal dot-path setter scoped to `dag.json`'s own JSON shape (e.g.
 * `"milestones.a.pending"`, `"optimization.b_override"`). Rejects prototype-
 * polluting segments and paths whose parent doesn't already resolve to an
 * object — `dag.set-field` sets an existing field, it never silently
 * scaffolds new nested structure.
 */
function setDagField(dag: DagJson, fieldPath: string, value: unknown): void {
  const segments = fieldPath.split('.');
  if (segments.length === 0 || segments.some((s) => UNSAFE_PATH_SEGMENTS.has(s) || s === '')) {
    throw new Error(`unsafe or empty path '${fieldPath}'`);
  }
  const lastSeg = segments[segments.length - 1];
  const parentSegs = segments.slice(0, -1);
  if (lastSeg === undefined) {
    throw new Error(`unsafe or empty path '${fieldPath}'`);
  }
  let cursor: Record<string, unknown> = dag as unknown as Record<string, unknown>;
  for (const seg of parentSegs) {
    const next = cursor[seg];
    if (next === null || typeof next !== 'object') {
      throw new Error(`path '${fieldPath}' does not resolve (missing/non-object segment '${seg}')`);
    }
    cursor = next as Record<string, unknown>;
  }
  cursor[lastSeg] = value;
}

/**
 * Resolves an `fs.*` tool-call path relative to `root`, rejecting anything
 * that escapes it (`..` traversal, absolute paths outside root). A
 * maliciously- or buggily-authored dag.json must never be able to move/
 * delete/scaffold files outside the configured tools root.
 */
function resolveToolPath(root: string, rel: string): string {
  const rootResolved = nodePath.resolve(root);
  const resolved = nodePath.resolve(rootResolved, rel);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + nodePath.sep)) {
    throw new Error(`path '${rel}' escapes tools root '${root}'`);
  }
  return resolved;
}

/**
 * Real, in-process execution for `type: "tool-call"` operations. See the
 * module-level comment above for why this lives here rather than in a new
 * `@adhd/dispatch-tools` package. Never throws — every failure mode (bad
 * args, unknown action, fs error) resolves to `{ ok: false, error }`.
 */
async function defaultToolCallExec(
  op: OperationDag,
  dag: DagJson,
  toolsRoot: string
): Promise<ToolCallResult> {
  const args = (op.args ?? {}) as Record<string, unknown>;
  try {
    switch (op.action) {
      case 'dag.set-field': {
        const fieldPath = requireStringArg(args, 'path');
        const value = args['value'];
        setDagField(dag, fieldPath, value);
        return { ok: true, result: { path: fieldPath, value } };
      }
      case 'dag.clear-pending': {
        const slug = requireStringArg(args, 'milestone');
        const milestone = dag.milestones[slug];
        if (!milestone) {
          return { ok: false, error: `unknown milestone '${slug}'` };
        }
        milestone.pending = null;
        return { ok: true, result: { milestone: slug, pending: null } };
      }
      case 'dag.add-milestone': {
        const slug = requireStringArg(args, 'slug');
        if (dag.milestones[slug]) {
          return { ok: false, error: `milestone '${slug}' already exists` };
        }
        const input = (args['milestone'] ?? {}) as Partial<MilestoneDag>;
        const created: MilestoneDag = {
          description: input.description ?? '',
          authored_by: input.authored_by ?? op.authored_by,
          pending: input.pending ?? null,
          triggered_by: input.triggered_by ?? null,
          phase: input.phase ?? '',
          depends_on: input.depends_on ?? [],
          agent: input.agent ?? null,
          model: input.model ?? null,
          effort: input.effort ?? null,
          two_stage: input.two_stage ?? false,
          read_only: input.read_only ?? [],
          guard: input.guard ?? null,
        };
        if (input.rationale !== undefined) created.rationale = input.rationale;
        dag.milestones[slug] = created;
        return { ok: true, result: { slug } };
      }
      case 'dag.append-dispatch-log': {
        const input = (args['entry'] ?? {}) as Partial<DispatchLogEntry>;
        const nowIso = new Date().toISOString();
        const entry: DispatchLogEntry = {
          id: input.id ?? randomUUID(),
          kind: input.kind ?? 'execution',
          provider: input.provider ?? 'local',
          model: input.model ?? null,
          agent: input.agent ?? GUARD_EXEC_AGENT_LABEL,
          effort: input.effort ?? null,
          started_at: input.started_at ?? nowIso,
          completed_at: input.completed_at ?? nowIso,
          operations: input.operations ?? [],
          turns: input.turns ?? [],
          results: input.results ?? [],
          notes: input.notes ?? [],
        };
        dag.dispatch_log.push(entry);
        return { ok: true, result: { id: entry.id } };
      }
      case 'fs.move': {
        const from = resolveToolPath(toolsRoot, requireStringArg(args, 'from'));
        const to = resolveToolPath(toolsRoot, requireStringArg(args, 'to'));
        await fsp.mkdir(nodePath.dirname(to), { recursive: true });
        await fsp.rename(from, to);
        return { ok: true, result: { from, to } };
      }
      case 'fs.delete': {
        const target = resolveToolPath(toolsRoot, requireStringArg(args, 'path'));
        const recursive = args['recursive'] === true;
        await fsp.rm(target, { recursive, force: false });
        return { ok: true, result: { path: target } };
      }
      case 'fs.scaffold': {
        const target = resolveToolPath(toolsRoot, requireStringArg(args, 'path'));
        const content = typeof args['content'] === 'string' ? (args['content'] as string) : '';
        await fsp.mkdir(nodePath.dirname(target), { recursive: true });
        await fsp.writeFile(target, content, 'utf8');
        return {
          ok: true,
          result: { path: target, bytes: Buffer.byteLength(content, 'utf8') },
        };
      }
      default:
        return {
          ok: false,
          error: `tool-call action '${op.action}' has no registered executor`,
        };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveDeps(deps: OrchestratorDeps): ResolvedDeps {
  const toolsRoot = deps.toolsRoot ?? process.cwd();
  return {
    client: deps.client,
    optimizer: deps.optimizer,
    runner: deps.runner,
    plugins: deps.plugins ?? {},
    bPerTier: deps.bPerTier ?? DEFAULT_B_PER_TIER,
    contextWindowPerTier: deps.contextWindowPerTier ?? DEFAULT_CONTEXT_WINDOW_PER_TIER,
    clock: deps.clock ?? defaultClock,
    idFactory: deps.idFactory ?? defaultIdFactory,
    sleep: deps.sleep ?? defaultSleep,
    poll: { ...DEFAULT_POLL, ...deps.poll },
    guardExec: deps.guardExec ?? defaultGuardExec,
    guardTimeoutMs: deps.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS,
    toolCallExec: deps.toolCallExec ?? ((op, dagArg) => defaultToolCallExec(op, dagArg, toolsRoot)),
    continueOnError: deps.continueOnError ?? true,
  };
}

// ---------------------------------------------------------------------------
// ── Result types ─────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** Per-milestone guard outcome recorded while handling one dispatch unit. */
export interface MilestoneGuardOutcome {
  milestone: string;
  /** `null` when the underlying dispatch never completed, so the guard was never run. */
  guardResult: GuardResult | null;
  guardOutput: string;
  /** Slug of the correction milestone injected because this guard failed, or `null`. */
  injectedCorrection: string | null;
}

/** Summary of how one `DispatchUnit` was handled within a cycle. */
export interface DispatchedUnitSummary {
  unitId: string;
  milestones: string[];
  agentName: string;
  /** `null` when no agent dispatch occurred (guard-only / tool-call-only unit). */
  taskId: string | null;
  taskStatus: DispatchTaskStatus | null;
  dispatchLogEntryId: string;
  guardOutcomes: MilestoneGuardOutcome[];
}

/** Result of one scheduling cycle (`orchestrateCycle`). */
export interface CycleResult {
  /** Every `DispatchUnit` handled this cycle, in dispatch order. */
  dispatched: DispatchedUnitSummary[];
  /** Slugs of correction milestones injected this cycle (guard failures). */
  injectedMilestones: string[];
  /** Whether `client.saveDag()` was called at least once this cycle. */
  persisted: boolean;
  /** True when there is no more work `orchestrate()` can do without external input. */
  terminal: boolean;
  /** Non-exhaustive: `'max-cycles-reached'` is synthesized only by `orchestrate()`, never `orchestrateCycle()`. */
  terminalReason: 'all-complete' | 'no-eligible-work' | 'max-cycles-reached' | null;
}

// ---------------------------------------------------------------------------
// ── Turn reconciliation (DEBT-DISPATCH-008) ─────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Reconciles the runner's `SynthesizedTurn[]` (agent-mcp's aggregate-only
 * usage shape — no `turn` index or timestamp) into real `Turn[]` for
 * `DispatchLogEntry.turns`: assigns a 1-based `turn` index, stamps `t` from
 * the injected clock, and carries `model_calls` through via the newly-added
 * optional `Turn.model_calls` field (@adhd/dispatch-base-spec `types.ts`).
 */
function reconcileTurns(synthesized: SynthesizedTurn[], clock: ClockFn): Turn[] {
  return synthesized.map((s, i) => ({
    turn: i + 1,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    t: clock(),
    model_calls: s.model_calls,
  }));
}

// ---------------------------------------------------------------------------
// ── Provider / max-tokens resolution ─────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Fills `DispatchUnit.provider`/`.resolved_max_tokens` from
 * `dag.providers`/`dag.effort_max_tokens`. `optimize()` always leaves these
 * `null` by design — see the `assembleUnit` docstring in
 * dispatch-optimizer/src/lib/optimize.ts: both fields require the full
 * `DagJson` (providers/effort_max_tokens live there, not on `DagSnapshot` or
 * `IOptimizerDeps`), and "orchestrator-core ... is the first component
 * downstream that holds the full DagJson and can fill them in." Mutates
 * `unit` in place — safe, because `optimize()`'s "does not mutate its input"
 * contract is about the *snapshot* it reads, not the fresh `DispatchUnit[]`
 * it returns as output.
 */
function resolveUnitProviderAndTokens(unit: DispatchUnit, dag: DagJson): void {
  if (unit.model != null) {
    unit.provider = dag.providers[unit.model] ?? null;
  }
  if (unit.effort != null) {
    unit.resolved_max_tokens = dag.effort_max_tokens[unit.effort] ?? null;
  }
}

// ---------------------------------------------------------------------------
// ── Polling ──────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Statuses that stop polling. `awaiting_input` (agent-mcp's human-in-the-loop
 * state) is treated as terminal-but-unresolved: this minimal loop has no
 * `task_resume` wiring, so it is handled the same as a failure (see
 * `dispatchUnit`) rather than polled forever.
 */
export const POLL_TERMINAL_STATUSES: ReadonlySet<DispatchTaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'awaiting_input',
]);

export interface PollOutcome {
  status: DispatchTaskStatus;
  usage: DispatchUsageReport | undefined;
  timedOut: boolean;
}

/**
 * Polls `runner.poll(taskId)` until a terminal status or the bounded deadline
 * (`poll.timeoutMs`, counted in `poll.intervalMs` increments via the injected
 * `sleep` — never a wall-clock read) is reached.
 */
export async function pollUntilTerminal(
  runner: IDispatchAgentRunner,
  taskId: string,
  poll: PollConfig,
  sleep: SleepFn
): Promise<PollOutcome> {
  let elapsedMs = 0;
  for (;;) {
    const { status, usage } = await runner.poll(taskId);
    if (POLL_TERMINAL_STATUSES.has(status)) {
      return { status, usage, timedOut: false };
    }
    if (elapsedMs >= poll.timeoutMs) {
      return { status, usage, timedOut: true };
    }
    await sleep(poll.intervalMs);
    elapsedMs += poll.intervalMs;
  }
}

// ---------------------------------------------------------------------------
// ── Replan injection (D-18 dag.inject) ──────────────────────────────────────
// ---------------------------------------------------------------------------

function nextCorrectionSlug(dag: DagJson, failedSlug: string): string {
  let n = 1;
  let candidate = `${failedSlug}-correction-${n}`;
  while (dag.milestones[candidate] !== undefined) {
    n += 1;
    candidate = `${failedSlug}-correction-${n}`;
  }
  return candidate;
}

/**
 * Replan injection (D-18 `dag.inject`; WORKFLOW.md "guard failure -> review +
 * correction milestones"): on guard failure for `failedSlug`, synthesize a
 * new milestone plus one generative `doc`-shaped operation and wire
 * `triggered_by` to the failing dispatch's id.
 *
 * SCOPE, DISCLOSED: this is a GENERIC, best-effort correction. It re-fires
 * the SAME agent/model/effort/guard as the failed milestone with a natural-
 * language "fix this" instruction (guard output inlined) — NOT a causally-
 * aware replan. WORKFLOW.md's richer example can target a *different*, truly
 * at-fault upstream milestone (e.g. an interface gap one layer up); that
 * requires plan-authoring judgment a generic loop does not have. This
 * function also does not rewire any OTHER milestone's `depends_on` onto the
 * correction, so a downstream milestone that depended on `failedSlug` will
 * not automatically pick up the fix — flagged in the completion report as a
 * BACKLOG-worthy follow-up (full replan choreography belongs to
 * workflow:plan-builder, not this minimal loop).
 *
 * Returns `null` (injects nothing) when `failedSlug`'s milestone has
 * `agent: null` — a true guard-only milestone (D-12) has no executor to hand
 * a correction to. Auto-injecting an LLM agent for what the schema defines as
 * a human-authored precondition (D-12: "pre-condition checks... human-
 * authored artifacts") would silently misrepresent the failure; the caller
 * records a note instead.
 */
function injectCorrectionMilestone(
  dag: DagJson,
  failedSlug: string,
  dispatchEntryId: string,
  guardOutput: string,
  extraReadOnly: string[]
): { slug: string; milestone: MilestoneDag; operation: OperationDag } | null {
  const original = dag.milestones[failedSlug];
  if (!original || original.agent == null) return null;

  const slug = nextCorrectionSlug(dag, failedSlug);
  const truncatedOutput =
    guardOutput.length > 1500 ? `${guardOutput.slice(0, 1500)}...[truncated]` : guardOutput;

  const milestone: MilestoneDag = {
    description: `Correction for milestone "${failedSlug}": its guard failed. Guard command: ${original.guard ?? '(none)'}\n\nGuard output:\n${truncatedOutput}\n\nDiagnose the cause and make the changes needed so the guard passes.`,
    rationale: `Auto-injected by dispatch-orchestrator (orchestrateCycle) after a guard failure on dispatch ${dispatchEntryId}.`,
    authored_by: 'dispatch-orchestrator',
    pending: null,
    triggered_by: dispatchEntryId,
    phase: original.phase,
    depends_on: [...original.depends_on],
    agent: original.agent,
    model: original.model,
    effort: original.effort,
    two_stage: false,
    read_only: Array.from(new Set([...original.read_only, ...extraReadOnly])),
    guard: original.guard,
  };

  const operation: OperationDag = {
    id: `${slug}.1`,
    milestone: slug,
    depends_on: [],
    type: 'generative',
    action: 'modify-body',
    file: null,
    symbol: null,
    provenance: 'assumed',
    confidence: 'assumed',
    audit_check: null,
    criteria: [],
    tool: null,
    args: null,
    guard: null,
    to_file: null,
    to_symbol: null,
    ki_estimate: null,
    ki_source: null,
    authored_by: 'dispatch-orchestrator',
    status: 'pending',
    shape: {
      kind: 'doc',
      description: `Fix milestone "${failedSlug}" so its guard passes.`,
      objective: `Guard command exits 0: ${original.guard ?? '(no guard configured)'}`,
      required_sections: [],
    },
  };

  return { slug, milestone, operation };
}

/**
 * Attempts to inject a correction for `slug`'s guard failure; on success,
 * writes the new milestone + operation into `dag`, records the slug in
 * `injectedSlugs`, and returns it. On failure (no agent to dispatch to),
 * pushes an explanatory note and returns `null`. Shared by both guard-exec
 * branches in `dispatchUnit` (dispatch-never-completed vs. guard-actually-ran).
 */
function injectFailureCorrection(
  dag: DagJson,
  slug: string,
  dispatchId: string,
  guardOutput: string,
  snap: DagSnapshot,
  injectedSlugs: string[],
  notes: DispatchNote[]
): string | null {
  const artifacts = snap.milestones[slug]?.artifacts ?? [];
  const injected = injectCorrectionMilestone(dag, slug, dispatchId, guardOutput, artifacts);
  if (!injected) {
    notes.push({
      level: 'error',
      text: `milestone '${slug}' guard failed and has no agent — cannot auto-inject a correction (guard-only milestones need manual intervention)`,
    });
    return null;
  }
  dag.milestones[injected.slug] = injected.milestone;
  (dag.operations as OperationDag[]).push(injected.operation);
  injectedSlugs.push(injected.slug);
  return injected.slug;
}

// ---------------------------------------------------------------------------
// ── Per-unit dispatch ────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Handles one `DispatchUnit`: optionally fires+polls a real agent dispatch,
 * then runs every packed milestone's guard, injects corrections for failures,
 * and appends exactly ONE `DispatchLogEntry` to `dag.dispatch_log` covering
 * both the agent-dispatch outcome and every milestone's guard result.
 */
async function dispatchUnit(
  unit: DispatchUnit,
  dag: DagJson,
  snap: DagSnapshot,
  deps: ResolvedDeps
): Promise<{ summary: DispatchedUnitSummary; injectedSlugs: string[] }> {
  const dispatchId = deps.idFactory();
  const startedAt = deps.clock();
  const notes: DispatchNote[] = [];

  let turns: Turn[] = [];
  let taskId: string | null = null;
  let taskStatus: DispatchTaskStatus | null = null;
  let opResultStatus: OperationStatus;
  const hasRealDispatch = unit.prompt != null;

  // Build operation lookup up front — needed both for real tool-call
  // execution (BUG-DISPATCH-EXEC-001) and for per-operation automated-guard
  // routing further below, regardless of which dispatch path this unit takes.
  const opLookup = new Map<string, OperationDag>();
  for (const op of dag.operations as OperationDag[]) {
    opLookup.set(op.id, op);
  }

  // Real per-op tool-call outcomes, keyed by op id. Populated below when this
  // unit has no generative content; consulted while building `results[]` so
  // each tool-call op's true outcome (never a blanket status) reaches the
  // dispatch_log — this is the fix for BUG-DISPATCH-EXEC-001.
  const toolCallOutcomes = new Map<string, ToolCallResult>();

  if (hasRealDispatch) {
    await deps.runner.ensureAgent(unit);
    const fired = await deps.runner.fire(unit);
    taskId = fired.taskId;

    const polled = await pollUntilTerminal(deps.runner, taskId, deps.poll, deps.sleep);
    taskStatus = polled.status;
    turns = reconcileTurns(usageToTurns(polled.usage), deps.clock);

    if (polled.timedOut) {
      opResultStatus = 'failed';
      notes.push({
        level: 'error',
        text: `dispatch ${dispatchId}: poll deadline (${deps.poll.timeoutMs}ms) exceeded for task '${taskId}' (last status: '${taskStatus}') — marking operations failed, skipping milestone guard(s)`,
      });
    } else if (taskStatus === 'completed') {
      opResultStatus = 'complete';
    } else {
      opResultStatus = 'failed';
      notes.push({
        level: 'warn',
        text: `dispatch ${dispatchId}: task '${taskId}' ended with status '${taskStatus}' (not 'completed') — marking operations failed, skipping milestone guard(s)`,
      });
    }
  } else if (unit.operations.length > 0) {
    // Non-empty operations with no prompt — tool-call ops (D-13 dag-mutation
    // + fs verbs) are executed for REAL below via `deps.toolCallExec`
    // (BUG-DISPATCH-EXEC-001 fix). Automated guard ops are executed inline
    // further down via op-level guard routing. Any OTHER automated action
    // (dag.inject/dag.wait/non-guard exec) has no registered executor yet
    // and is honestly marked 'skipped' — never silently claimed complete.
    let anyUnhandled = false;
    for (const opId of unit.operations) {
      const opDag = opLookup.get(opId);
      if (!opDag) {
        anyUnhandled = true;
        continue;
      }
      if (opDag.type === 'tool-call') {
        const outcome = await deps.toolCallExec(opDag, dag);
        toolCallOutcomes.set(opId, outcome);
        if (!outcome.ok) {
          notes.push({
            level: 'error',
            text: `unit '${unit.id}': tool-call op '${opId}' (action '${opDag.action}') failed: ${outcome.error ?? 'unknown error'}`,
          });
        }
        continue;
      }
      if (opDag.type === 'automated' && opDag.action === 'guard') {
        continue; // handled by the automated-guard loop below
      }
      anyUnhandled = true;
    }

    if (anyUnhandled) {
      notes.push({
        level: 'warn',
        text: `unit '${unit.id}': one or more operations have no registered executor (only tool-call and automated-guard ops are wired) — marking those 'skipped', proceeding to milestone guard(s)`,
      });
    }
    // Default fill for any op NOT individually resolved above (unhandled
    // ones only — real tool-call outcomes and automated guards each
    // overwrite their own entry below, never regressing to a false
    // 'complete'). Deliberately not 'failed': a tool-call/guard-only unit
    // still deserves its milestone guard(s) to run (see `shouldRunGuards`).
    opResultStatus = 'skipped';
  } else {
    // True guard-only milestone(s) (D-12): zero operations at all.
    opResultStatus = 'complete'; // vacuous — results[] below will be empty
    notes.push({
      level: 'info',
      text: `unit '${unit.id}' is guard-only (no operations) — skipping agent dispatch, running milestone guard(s) directly`,
    });
  }

  const results: DispatchResult[] = unit.operations.map((opId) => {
    const toolOutcome = toolCallOutcomes.get(opId);
    if (toolOutcome) {
      return {
        op_id: opId,
        status: toolOutcome.ok ? 'complete' : 'failed',
        guard_result: null,
        guard_output: null,
        guard_ran_at: null,
        tool_result: toolOutcome.ok
          ? (toolOutcome.result ?? null)
          : { error: toolOutcome.error ?? 'unknown error' },
      };
    }
    return {
      op_id: opId,
      status: opResultStatus,
      guard_result: null,
      guard_output: null,
      guard_ran_at: null,
      tool_result: null,
    };
  });

  const shouldRunDispatchedGuards = opResultStatus !== 'failed';

  // Execute per-operation automated guards (type:'automated'/action:'guard').
  // These are routed through the same GuardExecFn seam as milestone-level
  // guards, but operate at the operation level.
  for (const opId of unit.operations) {
    const opDag = opLookup.get(opId);
    if (
      !opDag ||
      opDag.type !== 'automated' ||
      opDag.action !== 'guard' ||
      opDag.guard == null
    ) {
      continue;
    }

    const resultEntry = results.find((r) => r.op_id === opId);
    if (!resultEntry) continue;

    if (!shouldRunDispatchedGuards) {
      const guardRanAt = deps.clock();
      resultEntry.status = 'failed';
      resultEntry.guard_result = 'fail';
      resultEntry.guard_output = `guard not run: dispatch ${dispatchId} did not complete (task status: ${taskStatus ?? 'n/a'})`;
      resultEntry.guard_ran_at = guardRanAt;
      continue;
    }

    const execResult = await deps.guardExec(opDag.guard, deps.guardTimeoutMs);
    const guardRanAt = deps.clock();
    const passed = execResult.exitCode === 0;
    resultEntry.status = passed ? 'complete' : 'failed';
    resultEntry.guard_result = passed ? 'pass' : 'fail';
    resultEntry.guard_output = execResult.output;
    resultEntry.guard_ran_at = guardRanAt;
  }

  const guardOpIds: string[] = [];
  const guardOutcomes: MilestoneGuardOutcome[] = [];
  const injectedSlugs: string[] = [];
  // Only skip verification when the underlying dispatch itself never
  // completed — a 'skipped' (tool-call) or 'complete' (guard-only / real
  // success) unit still deserves a real guard run.
  const shouldRunGuards = opResultStatus !== 'failed';

  for (const slug of unit.milestones) {
    const milestone = dag.milestones[slug];
    if (!milestone) {
      notes.push({
        level: 'error',
        text: `unit '${unit.id}' references unknown milestone '${slug}' — skipping its guard`,
      });
      continue;
    }
    const guardOpId = `${slug}.guard`;
    guardOpIds.push(guardOpId);

    if (!shouldRunGuards) {
      const guardRanAt = deps.clock();
      const failOutput = `guard not run: dispatch ${dispatchId} did not complete (task status: ${taskStatus ?? 'n/a'})`;
      results.push({
        op_id: guardOpId,
        status: 'failed',
        guard_result: 'fail',
        guard_output: failOutput,
        guard_ran_at: guardRanAt,
      });
      const injectedSlug = injectFailureCorrection(
        dag,
        slug,
        dispatchId,
        failOutput,
        snap,
        injectedSlugs,
        notes
      );
      guardOutcomes.push({
        milestone: slug,
        guardResult: 'fail',
        guardOutput: failOutput,
        injectedCorrection: injectedSlug,
      });
      continue;
    }

    if (!milestone.guard) {
      // No guard configured — nothing to verify; treat as an automatic pass.
      const guardRanAt = deps.clock();
      results.push({
        op_id: guardOpId,
        status: 'complete',
        guard_result: 'pass',
        guard_output: null,
        guard_ran_at: guardRanAt,
      });
      guardOutcomes.push({
        milestone: slug,
        guardResult: 'pass',
        guardOutput: '',
        injectedCorrection: null,
      });
      continue;
    }

    const execResult = await deps.guardExec(milestone.guard, deps.guardTimeoutMs);
    const guardRanAt = deps.clock();
    const passed = execResult.exitCode === 0;
    results.push({
      op_id: guardOpId,
      status: passed ? 'complete' : 'failed',
      guard_result: passed ? 'pass' : 'fail',
      guard_output: execResult.output,
      guard_ran_at: guardRanAt,
    });

    const injectedSlug = passed
      ? null
      : injectFailureCorrection(
          dag,
          slug,
          dispatchId,
          execResult.output,
          snap,
          injectedSlugs,
          notes
        );
    guardOutcomes.push({
      milestone: slug,
      guardResult: passed ? 'pass' : 'fail',
      guardOutput: execResult.output,
      injectedCorrection: injectedSlug,
    });
  }

  const completedAt = deps.clock();
  const entry: DispatchLogEntry = {
    id: dispatchId,
    kind: 'execution',
    // DispatchLogEntry.provider is a closed enum ('anthropic'|'openai'|
    // 'deepseek'|'google'|'local') that predates agent-mcp's 'claudecli'
    // provider type — AgentMcpRunner always creates agents with
    // { type: 'claudecli' } (see agent-runner.ts ensureAgent), which has no
    // exact match in this enum. 'anthropic' is the closest honest fit (the
    // underlying model IS Claude/Anthropic); flagged in the completion
    // report as a real dispatch-spec/agent-mcp schema gap, not papered over.
    provider: hasRealDispatch ? 'anthropic' : 'local',
    model: hasRealDispatch ? unit.model : null,
    agent: hasRealDispatch ? unit.agent_name : GUARD_EXEC_AGENT_LABEL,
    effort: unit.effort,
    started_at: startedAt,
    completed_at: completedAt,
    operations: [...unit.operations, ...guardOpIds],
    turns,
    results,
    notes,
  };
  dag.dispatch_log.push(entry);

  return {
    summary: {
      unitId: unit.id,
      milestones: unit.milestones,
      agentName: unit.agent_name,
      taskId,
      taskStatus,
      dispatchLogEntryId: dispatchId,
      guardOutcomes,
    },
    injectedSlugs,
  };
}

// ---------------------------------------------------------------------------
// ── Public API ───────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Runs exactly one scheduling cycle: snapshot -> optimize -> dispatch every
 * returned unit (with per-unit persistence) -> return a `CycleResult`.
 *
 * Resumption is free: `client.load()` returns whatever was last persisted
 * (including every prior `dispatch_log` entry), so `snapshot()` derives
 * accurate `status`/`eligible` for every milestone before `optimize()` ever
 * runs — a milestone this function (or a prior process) already marked
 * complete is never re-selected (optimize.ts `selectPackableMilestones`
 * requires `status === 'pending'`).
 */
export async function orchestrateCycle(deps: OrchestratorDeps): Promise<CycleResult> {
  const resolved = resolveDeps(deps);
  const dag = await resolved.client.load();

  const optimizerDeps: IOptimizerDeps = {
    bPerTier: resolved.bPerTier,
    contextWindowPerTier: resolved.contextWindowPerTier,
    fileSizes: resolved.plugins.io?.fileSizes,
    readFiles: resolved.plugins.io?.readFiles,
  };

  const snap = resolved.optimizer.snapshot(dag, optimizerDeps);
  const units = resolved.optimizer.optimize(snap, optimizerDeps);

  if (units.length === 0) {
    const allComplete = Object.values(snap.milestones).every(
      (m) => m.status === 'complete' || m.status === 'skipped'
    );
    return {
      dispatched: [],
      injectedMilestones: [],
      persisted: false,
      terminal: true,
      terminalReason: allComplete ? 'all-complete' : 'no-eligible-work',
    };
  }

  const dispatched: DispatchedUnitSummary[] = [];
  const injectedMilestones: string[] = [];
  let persisted = false;

  for (const unit of units) {
    resolveUnitProviderAndTokens(unit, dag);
    try {
      const { summary, injectedSlugs } = await dispatchUnit(unit, dag, snap, resolved);
      dispatched.push(summary);
      injectedMilestones.push(...injectedSlugs);

      // Persist after EVERY unit (not just at cycle end) so a crash mid-cycle
      // never loses an already-completed unit's work on restart.
      await resolved.client.saveDag(dag);
      persisted = true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const failId = resolved.idFactory();
      const failStartedAt = resolved.clock();
      const failCompletedAt = resolved.clock();
      const failEntry: DispatchLogEntry = {
        id: failId,
        kind: 'execution',
        provider: 'local',
        model: null,
        agent: unit.agent_name,
        effort: unit.effort ?? null,
        started_at: failStartedAt,
        completed_at: failCompletedAt,
        operations: [...unit.operations, ...unit.milestones.map((s) => `${s}.guard`)],
        turns: [],
        results: [
          ...unit.operations.map((opId) => ({
            op_id: opId,
            status: 'failed' as const,
            guard_result: null as GuardResult | null,
            guard_output: null as string | null,
            guard_ran_at: null as string | null,
          })),
          ...unit.milestones.map((slug) => ({
            op_id: `${slug}.guard`,
            status: 'failed' as const,
            guard_result: 'fail' as GuardResult,
            guard_output: `uncaught error: ${errMsg}`,
            guard_ran_at: failCompletedAt,
          })),
        ],
        notes: [
          {
            level: 'error',
            text: `unit '${unit.id}' failed with uncaught error: ${errMsg}`,
          },
        ],
      };
      dag.dispatch_log.push(failEntry);

      dispatched.push({
        unitId: unit.id,
        milestones: unit.milestones,
        agentName: unit.agent_name,
        taskId: null,
        taskStatus: null,
        dispatchLogEntryId: failId,
        guardOutcomes: unit.milestones.map((slug) => ({
          milestone: slug,
          guardResult: 'fail' as GuardResult,
          guardOutput: `uncaught error: ${errMsg}`,
          injectedCorrection: null,
        })),
      });

      if (!resolved.continueOnError) throw err;
    }
  }

  return {
    dispatched,
    injectedMilestones,
    persisted,
    terminal: false,
    terminalReason: null,
  };
}

/**
 * Drives `orchestrateCycle()` repeatedly, yielding each cycle's result, until
 * a cycle reports `terminal: true` or `deps.maxCycles` is reached (see
 * `OrchestratorDeps.maxCycles` for why that safety cap exists).
 */
export async function* orchestrate(deps: OrchestratorDeps): AsyncIterable<CycleResult> {
  const maxCycles = deps.maxCycles ?? DEFAULT_MAX_CYCLES;
  let count = 0;
  for (;;) {
    if (count >= maxCycles) {
      yield {
        dispatched: [],
        injectedMilestones: [],
        persisted: false,
        terminal: true,
        terminalReason: 'max-cycles-reached',
      };
      return;
    }
    count += 1;
    const result = await orchestrateCycle(deps);
    yield result;
    if (result.terminal) return;
  }
}
