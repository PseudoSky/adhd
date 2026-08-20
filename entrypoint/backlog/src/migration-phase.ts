/**
 * migration-phase.ts — the STORE-FREE reading/writing path behind
 * `backlog migration-status` / `backlog set-migration-phase`. Extracted from
 * `client.ts`'s `migrationStatus()`/`setMigrationPhase()` so `cli.ts`'s
 * `runBacklogCli` can short-circuit both commands BEFORE ever building the
 * apigen package/opening the backing SQLite store
 * (DEBT-BACKLOG-CLI-STORE-OPEN-001): both commands only read/write the
 * `migration.phase` config cascade (`env.config.migration.phase`, and
 * `migration-admin.ts`'s `writeMigrationPhase` for the durable global
 * `config.yaml` write) — never the graph store — so neither must pay the
 * open+close of a real store the way a genuinely store-needing command
 * (e.g. `list-items`) does.
 *
 * This file is deliberately NOT an apigen extraction surface (only
 * `client.ts` is — see `server.ts`'s `extractClientOperations()`), so adding
 * `readBacklogMigrationStatus`/`setBacklogMigrationPhase` here introduces no
 * new CLI/MCP/HTTP command the way an extra `client.ts` export would.
 */
import type { Environment } from '@adhd/environment';
import type { BacklogConfig } from './env.js';
import { writeMigrationPhase } from './migration-admin.js';
import type { MigrationPhase, MigrationStatusResult, SetMigrationPhaseResult } from './model.js';

/**
 * The full, ordered `MigrationPhase` vocabulary (`model.ts`'s union, kept as
 * a runtime array for CLI flag validation in `cli.ts`'s store-free
 * short-circuit — the extracted JSON Schema's `enum` equivalent).
 */
export const MIGRATION_PHASES: readonly MigrationPhase[] = [
  'not-started',
  'phase-1',
  'phase-2',
  'phase-3',
  'phase-4',
  'phase-5',
  'complete',
];

const MIGRATION_PHASE_DESCRIPTIONS: Record<MigrationPhase, string> = {
  'not-started': 'not-started: BACKLOG.md is authoritative everywhere; the tool has not been adopted for this repo yet.',
  'phase-1': 'phase-1: seed import complete (or in progress) — BACKLOG.md remains authoritative; the graph is a read-only shadow copy.',
  'phase-2': 'phase-2: BACKLOG.md is still authoritative; the tool is shadow-running in parity-check mode (render vs. hand-edited markdown, non-blocking).',
  'phase-3': 'phase-3: the graph is authoritative. File/claim/transition/resolve via the backlog CLI/MCP — every BACKLOG.md is a generated projection, never hand-edited.',
  'phase-4': 'phase-4: phase-3 write path is live; the backlog-usage skill is published and distributed for agent discovery.',
  'phase-5': 'phase-5: the legacy tools/util/backlog.mjs parser has been deprecated/removed.',
  complete: 'complete: migration fully done, including cross-repo rollout (Phase 6) where applicable.',
};

/** `MigrationStatusResult`'s description/`toolIsAuthoritative` fields for a phase — shared by both store-free operations below and `client.ts`'s delegated exports. */
export function describeMigrationPhase(phase: MigrationPhase): MigrationStatusResult {
  const description = MIGRATION_PHASE_DESCRIPTIONS[phase] ?? `unknown phase value: ${phase}`;
  const toolIsAuthoritative = phase === 'phase-3' || phase === 'phase-4' || phase === 'phase-5' || phase === 'complete';
  return { phase, description, toolIsAuthoritative };
}

/**
 * Reports the live `migration.phase` config value (`env.config.migration.phase`,
 * env-overridable via `ADHD_BACKLOG_MIGRATION_PHASE`). Store-free — callable
 * by `client.ts`'s `migrationStatus()` (apigen-dispatched, ctx-carrying) and
 * by `cli.ts`'s `migration-status` short-circuit (never opens the store)
 * identically.
 */
export function readBacklogMigrationStatus(env: Environment<BacklogConfig>): MigrationStatusResult {
  const phase = env.config.migration.phase as MigrationPhase;
  return describeMigrationPhase(phase);
}

/**
 * Persists `phase` to the GLOBAL layer's `config.yaml`
 * (`migration-admin.ts`'s `writeMigrationPhase`) and reports the result —
 * the store-free counterpart of `client.ts`'s `setMigrationPhase()`
 * (`adhdRootOverride` is the same test-isolation escape hatch `BacklogCtx.adhdRoot`
 * threads through; production callers never pass it).
 *
 * `configPath` is deliberately spread FIRST: the apigen dispatch path's
 * validate-Layer re-serializes a `client.ts` function's return value into its
 * JSON-Schema property order, and the extracted `SetMigrationPhaseResult`
 * schema orders `configPath` before the `MigrationStatusResult` fields
 * (verified empirically: `backlog set-migration-phase --phase phase-3` prints
 * `{"configPath":…,"phase":…,"description":…,"toolIsAuthoritative":…}` even
 * though `client.ts`'s source constructs `{ …describeMigrationPhase(phase),
 * configPath }`), so this short-circuit builds the same shape to keep stdout
 * byte-identical to the apigen path.
 */
export function setBacklogMigrationPhase(
  env: Environment<BacklogConfig>,
  phase: MigrationPhase,
  adhdRootOverride?: string
): SetMigrationPhaseResult {
  const configPath = writeMigrationPhase(env, phase, adhdRootOverride);
  return { configPath, ...describeMigrationPhase(phase) };
}
