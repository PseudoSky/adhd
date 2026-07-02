/**
 * api.ts — the apigen extraction surface for dispatch-cli.
 *
 * Plain, JSDoc'd async functions ONLY — no interfaces, no class instances, no
 * function-typed parameters. `@adhd/apigen` (see `generate-cli` in
 * `project.json`) reads exactly this file (ts-morph + ts-json-schema-generator)
 * to derive a JSON Schema per export and project it to a Commander CLI (one
 * `.command()` per export, flags derived from each schema's `data.properties`).
 * A parameter typed as an interface with methods (an injected runner, a
 * client) is not JSON-Schema-representable — every real dependency wire-up
 * lives in `./lib/core.ts` instead, which this file calls into.
 *
 * This CLI does no business logic of its own — it is a thin command router
 * over the real dispatch-production stack: `@adhd/dispatch-spec` (validation),
 * `@adhd/dispatch-client` + `@adhd/dispatch-serializer-json` (dag I/O),
 * `@adhd/dispatch-optimizer` (snapshot/optimize), and
 * `@adhd/dispatch-orchestrator` (the scheduling cycle + agent-mcp runner).
 *
 * See docs/plan/dispatch-production/dag.json milestones["cli"] (ops cli.1,
 * cli.2) for the shape contract this file implements.
 *
 * TWO command routers exist for THIS SAME contract: the apigen-generated one
 * (`generate-cli` target -> dist/packages/dispatch/dispatch-cli/cli/cli.ts;
 * currently correct for `eligible`/`status` only — see `run`'s JSDoc below
 * for the documented apigen-core/apigen-logical bug affecting the other
 * five) and `../bin/cli.ts` (a hand-written fallback, fully working, the one
 * this package's tests actually spawn and the one meant for real use today).
 * Both read this file and only this file — it remains the single contract.
 */

import type { DagSnapshot, DispatchUnit, ValidationResult } from '@adhd/dispatch-spec';
import type { CycleResult } from '@adhd/dispatch-orchestrator';
import {
  buildProductionAgentMcpRunner,
  calibrateCore,
  DEFAULT_CALIBRATION_PATH,
  eligibleCore,
  optimizeCore,
  runCycleCore,
  snapshotCore,
  statusCore,
  validateCore,
  type CalibrationResult,
  type MilestoneStatusEntry,
} from './lib/core.js';

/**
 * Validates a plan `dag.json` against `@adhd/dispatch-spec`'s structural
 * validator (`validateDagJson`). Read-only — never mutates the dag.
 *
 * Via the apigen-GENERATED CLI this currently crashes (see `run`'s JSDoc for
 * the documented apigen-core/apigen-logical bug); works via `../bin/cli.ts`.
 *
 * @param dagPath - Path to the plan's `dag.json`.
 */
export async function validate(dagPath: string): Promise<ValidationResult> {
  return validateCore(dagPath);
}

/**
 * Computes a fresh `DagSnapshot` for `dagPath`: a real `DagClient` load, then
 * `@adhd/dispatch-optimizer`'s `snapshot()` using cold-start B / context-window
 * defaults (no calibration file is consulted). Read-only.
 *
 * Via the apigen-GENERATED CLI this currently crashes (see `run`'s JSDoc for
 * the documented apigen-core/apigen-logical bug); works via `../bin/cli.ts`.
 *
 * @param dagPath - Path to the plan's `dag.json`.
 */
export async function snapshot(dagPath: string): Promise<DagSnapshot> {
  return snapshotCore(dagPath);
}

/**
 * Computes the next batch of `DispatchUnit`s the greedy optimizer would pack
 * right now: `snapshot()` followed by `optimize()`. Read-only — does not
 * dispatch anything.
 *
 * Via the apigen-GENERATED CLI this currently crashes (see `run`'s JSDoc for
 * the documented apigen-core/apigen-logical bug); works via `../bin/cli.ts`.
 *
 * @param dagPath - Path to the plan's `dag.json`.
 */
export async function optimize(dagPath: string): Promise<DispatchUnit[]> {
  return optimizeCore(dagPath);
}

/**
 * Lists milestone slugs eligible for dispatch right now: own `pending` gate
 * open, and every dependency complete per `dispatch_log`
 * (`DagClient.getEligibleMilestones`). Read-only.
 *
 * @param dagPath - Path to the plan's `dag.json`.
 */
export async function eligible(dagPath: string): Promise<string[]> {
  return eligibleCore(dagPath);
}

/**
 * Per-milestone status report derived from the current snapshot plus
 * `dispatch_log`: `status` (the snapshot's derived milestone status),
 * `loggedOperationIds` (this milestone's own operation ids with at least one
 * recorded dispatch_log result), and `tokensEstimated`/`tokensActual`
 * (carried straight from the snapshot). Read-only.
 *
 * @param dagPath - Path to the plan's `dag.json`.
 */
export async function status(dagPath: string): Promise<Record<string, MilestoneStatusEntry>> {
  return statusCore(dagPath);
}

/**
 * Runs exactly one `@adhd/dispatch-orchestrator` scheduling cycle against
 * `dagPath`: snapshot -> optimize -> dispatch every returned unit -> persist
 * (one `dispatch_log` entry appended per dispatched unit).
 *
 * `dryRun` (default `true`) selects the execution backend:
 *   - `true` (default): `MockAgentRunner` — no network, no cost, fully
 *     deterministic. Safe to run unattended, including in tests/CI.
 *   - `false`: a real `AgentMcpRunner` spawning `npx -y @adhd/agent-mcp` —
 *     THIS IS A PAID BOUNDARY. Every dispatched unit fires a real, billed
 *     model call. NOT exercised by this package's default-running tests.
 *
 * A DEFAULT VALUE, not a `?` optional marker: ts-json-schema-generator
 * represents `dryRun?: boolean` as `anyOf: [null, boolean]`, which the
 * cli-output plugin's `isBoolean` check (`schemaProps[param]?.type ===
 * 'boolean'`) doesn't recognize — the generated flag falls back to a
 * value-taking `--dry-run <dry-run>`. `dryRun = true` (default value, type
 * inferred) extracts as a clean `{ type: 'boolean' }` (still absent from
 * `required`), which DOES project to a presence-only `--dry-run` flag.
 * Verified empirically via `--type jsonschema` on both shapes during the cli
 * milestone build.
 *
 * GENERATED-CLI STATUS: `run` (like `validate`/`snapshot`/`optimize`/
 * `calibrate`) currently crashes through the apigen-GENERATED CLI —
 * `Error: [apigen-logical] $ref "#/definitions/<type>" cannot be resolved in
 * run-mode` — a genuine apigen-core/apigen-logical bug (zod, reachable
 * transitively via this module's `AgentMcpRunner` import chain into
 * `@modelcontextprotocol/sdk`, corrupts ts-json-schema-generator's shared
 * definitions registry for unrelated primitive types). NOT the cli-output
 * plugin, and out of this milestone's authorized scope to fix — see
 * `../../bin/cli.ts` for the authorized fallback (a hand-written thin
 * Commander wrapper calling this file directly) and the cli milestone
 * completion report for the full diagnosis (BACKLOG-destined).
 * `bin/cli.ts` — the CLI actually shipped and tested by this package — uses
 * Commander's native `--no-dry-run` negation, so it CAN reach `dryRun:
 * false` from the command line (unlike the apigen-generated projection,
 * which only ever supports presence-only boolean flags).
 *
 * @param dagPath - Path to the plan's `dag.json`. Mutated in place when the
 *   cycle does real work (a `dispatch_log` entry is appended and persisted).
 * @param dryRun - See above. Optional, defaults to `true`.
 */
export async function run(dagPath: string, dryRun = true): Promise<CycleResult> {
  return runCycleCore(dagPath, dryRun);
}

/**
 * Fires a trivial "null task" against a real `AgentMcpRunner` (`npx -y
 * @adhd/agent-mcp`) to measure a baseline per-tier token cost ("B" — see
 * `@adhd/dispatch-orchestrator`'s `DEFAULT_B_PER_TIER`), then merges the
 * measurement into `~/.adhd/dispatch-calibration.json` (keyed by model tier,
 * preserving any other tiers already recorded there).
 *
 * THIS IS A PAID BOUNDARY: every call fires one real, billed model call. NOT
 * exercised by this package's default-running tests, which call
 * `calibrateCore` directly with an injected `MockAgentRunner` and a path
 * under `tmp/dispatch-cli/` instead.
 *
 * Via the apigen-GENERATED CLI this currently crashes (see `run`'s JSDoc for
 * the documented apigen-core/apigen-logical bug); works via `../bin/cli.ts`
 * (both PAID either way — the CLI wrapper choice doesn't change that).
 *
 * @param modelTier - One of `'Haiku' | 'Sonnet' | 'Opus'` (validated at
 *   runtime — any other value throws).
 */
export async function calibrate(modelTier: string): Promise<CalibrationResult> {
  return calibrateCore(modelTier, buildProductionAgentMcpRunner(), DEFAULT_CALIBRATION_PATH);
}
