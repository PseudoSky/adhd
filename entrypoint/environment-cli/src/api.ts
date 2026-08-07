/**
 * `api.ts` — apigen extraction surface for `@adhd/environment-cli`.
 *
 * Every exported async function becomes a CLI command. Parameters are
 * scalar primitives (`string`, `number`, `boolean`) — the apigen
 * extractor derives JSON Schema from these.
 *
 * DEMOTED per `packages/environment/ARCHITECTURE.md` §4: this CLI is a
 * THIN, OPTIONAL wrapper over `@adhd/environment-builder` — never required
 * for a consumer to run `@adhd/environment` (the code-first `Environment<T>`
 * class is the primary, self-sufficient API). Ships 9 commands:
 * `init`/`build`/`set`/`status`/`export` (Wave 2) plus `verify`/`diff`/
 * `configGet`/`doctor` (DEBT-ENV-CLI-001, closed — see
 * `packages/environment/BACKLOG.md` §history / repo `CHANGELOG.md`), all
 * re-implemented against the redesigned, code-first `EnvironmentSpec<T>`
 * (dynamically-`import()`ed compiled spec module) rather than the
 * pre-redesign single canonical YAML spec format.
 *
 * All functions delegate to `core.ts`, which owns the real implementation.
 * The builder engine (`@adhd/environment-builder`) owns all resolve/
 * validation/hashing/persistence logic.
 */

import type { Scope } from '@adhd/environment-base-spec';

// -----------------------------------------------------------------------
// Shared result types (apigen-serialisable)
// -----------------------------------------------------------------------

export interface InitResult {
  success: boolean;
  path: string;
  template: string;
}

export interface BuildResult {
  success: boolean;
  project: string;
  namespace: string;
  scope: string;
  snapshotPath: string;
  configHash: string;
  structureHash: string;
  fieldCount: number;
  dirCount: number;
  errors: string[];
}

export interface SetResult {
  success: boolean;
  filePath: string;
  scope: string;
  field: string;
  value: unknown;
  message: string;
}

export interface StatusResult {
  project: string;
  namespace: string;
  scope: string;
  snapshotPath: string;
  snapshotExists: boolean;
  configHash: string;
  generatedAt: string;
  fieldCount: number;
  dirCount: number;
}

export interface ExportResult {
  snapshot: object | string;
}

export interface DiffEntryResult {
  field: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface VerifyResult {
  project: string;
  namespace: string;
  scope: string;
  snapshotPath: string;
  snapshotExists: boolean;
  verified: boolean;
  drift: DiffEntryResult[];
  message: string;
}

export interface DiffSide {
  source: 'build' | 'snapshot';
  path: string;
}

export interface DiffResult {
  left: DiffSide;
  right: DiffSide;
  identical: boolean;
  changes: DiffEntryResult[];
}

export interface ConfigGetResult {
  project: string;
  field: string;
  found: boolean;
  value: unknown;
  provenance: { source: string; scope: string; env?: string } | null;
}

export interface DoctorCheckResult {
  name: string;
  passed: boolean;
  message: string;
}

export interface DoctorResult {
  project: string;
  healthy: boolean;
  checks: DoctorCheckResult[];
  summary: string;
}

// -----------------------------------------------------------------------
// 1. init — scaffold a starter code-first spec module
// -----------------------------------------------------------------------

/**
 * Scaffold a starter `adhd.environment.spec.mjs` (a code-first
 * `EnvironmentSpec` module) in `targetDir`.
 *
 * CLI: adhd-env init [--generate-config] [--target-dir <dir>]
 */
export async function init(generateConfig = false, targetDir = ''): Promise<InitResult> {
  const { initProject } = await import('./core.js');
  return initProject(generateConfig, targetDir || undefined);
}

// -----------------------------------------------------------------------
// 2. build — resolve (and persist) a project's environment snapshot
// -----------------------------------------------------------------------

/**
 * Build the environment snapshot for `project` from the `EnvironmentSpec`
 * exported by the JS/MJS module at `specPath`, and (unless `dryRun`)
 * persist it via `Environment#write()`'s on-disk convention.
 *
 * CLI: adhd-env build <project> <specPath> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>] [--dry-run]
 */
export async function build(
  project: string,
  specPath: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
  dryRun = false,
): Promise<BuildResult> {
  const { loadSpecModule, buildAndMaybeWrite } = await import('./core.js');
  try {
    const spec = await loadSpecModule(specPath);
    const { data, ctx, snapshotPath } = buildAndMaybeWrite(project, spec, {
      namespace: namespace || undefined,
      scope: (scope || undefined) as Scope | undefined,
      adhdRoot: adhdRoot || undefined,
      dryRun,
    });
    return {
      success: true,
      project,
      namespace: ctx.namespace,
      scope: ctx.scope,
      snapshotPath,
      configHash: data.configHash,
      structureHash: data.structureHash,
      fieldCount: Object.keys(data.raw).length,
      dirCount: data.dirs.length,
      errors: [],
    };
  } catch (err) {
    return {
      success: false,
      project,
      namespace,
      scope,
      snapshotPath: '',
      configHash: '',
      structureHash: '',
      fieldCount: 0,
      dirCount: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

// -----------------------------------------------------------------------
// 3. set — write one field override into the active scope's config layer
// -----------------------------------------------------------------------

/**
 * Merge `{ [field]: value }` into the resolved scope's `config.yaml` (or
 * `config.local.yaml` with `--local`) layer file — the redesign's cascade
 * layer that `Environment`/`buildSnapshot` read natively (no side-channel
 * store).
 *
 * CLI: adhd-env set <project> <specPath> <field> <value> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>] [--local]
 */
export async function set(
  project: string,
  specPath: string,
  field: string,
  value: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
  local = false,
): Promise<SetResult> {
  const { loadSpecModule, setLayerValue } = await import('./core.js');
  const spec = await loadSpecModule(specPath);
  const result = setLayerValue(project, spec, field, value, {
    namespace: namespace || undefined,
    scope: (scope || undefined) as Scope | undefined,
    adhdRoot: adhdRoot || undefined,
    local,
  });
  return {
    success: true,
    filePath: result.filePath,
    scope: result.scope,
    field: result.field,
    value: result.value,
    message: `Set ${field}=${String(result.value)} in ${result.filePath}`,
  };
}

// -----------------------------------------------------------------------
// 4. status — show a project's currently-resolved environment status
// -----------------------------------------------------------------------

/**
 * Show the current environment status for `project`: resolves the spec
 * live (same cascade `Environment` uses) and reports its identity + hash,
 * plus whether a `.write()`-persisted snapshot already exists on disk.
 *
 * CLI: adhd-env status <project> <specPath> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>]
 */
export async function status(
  project: string,
  specPath: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
): Promise<StatusResult> {
  const { loadSpecModule, buildAndMaybeWrite, readSnapshotFile, resolveSnapshotPath } = await import('./core.js');
  const spec = await loadSpecModule(specPath);
  const { data, ctx } = buildAndMaybeWrite(project, spec, {
    namespace: namespace || undefined,
    scope: (scope || undefined) as Scope | undefined,
    adhdRoot: adhdRoot || undefined,
    dryRun: true,
  });
  const snapshotPath = resolveSnapshotPath(ctx.roots, ctx.scope);
  const onDisk = readSnapshotFile(snapshotPath);

  return {
    project,
    namespace: ctx.namespace,
    scope: ctx.scope,
    snapshotPath,
    snapshotExists: onDisk.exists,
    configHash: data.configHash,
    generatedAt: data.generatedAt,
    fieldCount: Object.keys(data.raw).length,
    dirCount: data.dirs.length,
  };
}

// -----------------------------------------------------------------------
// 5. exportSnapshot — export the fully-resolved snapshot as JSON
// -----------------------------------------------------------------------

/**
 * Resolve `project`'s environment live and export the full snapshot as
 * JSON — to stdout (returned) or to `output` when given.
 *
 * CLI: adhd-env export <project> <specPath> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>] [--output <file>] [--pretty]
 */
export async function exportSnapshot(
  project: string,
  specPath: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
  output = '',
  pretty = true,
): Promise<ExportResult> {
  const { loadSpecModule, buildAndMaybeWrite } = await import('./core.js');
  const spec = await loadSpecModule(specPath);
  const { data } = buildAndMaybeWrite(project, spec, {
    namespace: namespace || undefined,
    scope: (scope || undefined) as Scope | undefined,
    adhdRoot: adhdRoot || undefined,
    dryRun: true,
  });

  if (output) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(output, JSON.stringify(data, null, pretty ? 2 : undefined), 'utf8');
    return { snapshot: output };
  }

  return { snapshot: data as unknown as object };
}

// -----------------------------------------------------------------------
// 6. verify — diff a fresh live-resolve against the persisted snapshot
// -----------------------------------------------------------------------

/**
 * Resolves `project`'s environment live (the same cascade `Environment`
 * uses) and diffs its `raw` config against whatever `.write()`-persisted
 * snapshot currently sits on disk at the resolved scope. `verified` is
 * `false` (and `process.exitCode` is set to `1`, so a real generated CLI —
 * or this process when driven as a script — exits non-zero) when either no
 * persisted snapshot exists yet, or one exists but has drifted from the
 * live-resolved cascade (a stale `config.yaml`/env var change since the
 * last `build`).
 *
 * CLI: adhd-env verify <project> <specPath> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>]
 */
export async function verify(
  project: string,
  specPath: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
): Promise<VerifyResult> {
  const { loadSpecModule, verifySnapshot } = await import('./core.js');
  const spec = await loadSpecModule(specPath);
  const outcome = verifySnapshot(project, spec, {
    namespace: namespace || undefined,
    scope: (scope || undefined) as Scope | undefined,
    adhdRoot: adhdRoot || undefined,
  });

  const verified = outcome.snapshotExisted && outcome.drift.length === 0;
  if (!verified) {
    process.exitCode = 1;
  }

  let message: string;
  if (!outcome.snapshotExisted) {
    message = `No persisted snapshot found at ${outcome.snapshotPath} — run "adhd-env build" first`;
  } else if (verified) {
    message = `Environment for "${project}" matches the persisted snapshot at ${outcome.snapshotPath}`;
  } else {
    message = `Drift detected: ${outcome.drift.length} field(s) differ from the persisted snapshot at ${outcome.snapshotPath}`;
  }

  return {
    project,
    namespace: outcome.namespace,
    scope: outcome.scope,
    snapshotPath: outcome.snapshotPath,
    snapshotExists: outcome.snapshotExisted,
    verified,
    drift: outcome.drift,
    message,
  };
}

// -----------------------------------------------------------------------
// 7. diff — compare two snapshots, or a snapshot vs. a fresh live build
// -----------------------------------------------------------------------

/**
 * Compares the `raw` (flat dot-path) config of two sides and reports every
 * field that differs. Each side is independently either:
 *  - an explicit `.write()`-persisted snapshot file path (`leftSnapshotPath`
 *    / `rightSnapshotPath`), or
 *  - when left blank: a FRESH live build of `project`'s spec (never
 *    persisted — a dry-run resolve), or
 *  - when right blank: the persisted snapshot currently on disk at the
 *    resolved scope root.
 *
 * With both paths blank this reduces to exactly `verify`'s comparison
 * (fresh build vs. persisted snapshot) but reported as a full change list
 * rather than a pass/fail; with both paths given it is a pure two-snapshot
 * comparison and does not touch the live cascade at all.
 *
 * CLI: adhd-env diff <project> <specPath> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>] [--left-snapshot-path <path>] [--right-snapshot-path <path>]
 */
export async function diff(
  project: string,
  specPath: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
  leftSnapshotPath = '',
  rightSnapshotPath = '',
): Promise<DiffResult> {
  const { loadSpecModule, buildAndMaybeWrite, readSnapshotFile, resolveSnapshotPath, diffRaw } = await import(
    './core.js'
  );
  const spec = await loadSpecModule(specPath);
  const buildOpts = {
    namespace: namespace || undefined,
    scope: (scope || undefined) as Scope | undefined,
    adhdRoot: adhdRoot || undefined,
    dryRun: true,
  };

  // A single fresh (dry-run) build supplies both the "fresh build" side (if
  // requested) and the resolved scope roots needed to locate the default
  // "persisted snapshot" side — never written to disk (dryRun: true).
  const built = buildAndMaybeWrite(project, spec, buildOpts);

  const readSide = (explicitPath: string, label: 'left' | 'right'): { source: 'snapshot'; path: string; raw: Record<string, unknown> } => {
    const read = readSnapshotFile(explicitPath);
    if (!read.exists || !read.data) {
      throw new Error(`${label} snapshot not found or unreadable at ${explicitPath}`);
    }
    return { source: 'snapshot', path: explicitPath, raw: read.data.raw };
  };

  const left = leftSnapshotPath
    ? readSide(leftSnapshotPath, 'left')
    : ({ source: 'build', path: '(fresh build)', raw: built.data.raw } as const);

  const right = rightSnapshotPath
    ? readSide(rightSnapshotPath, 'right')
    : (() => {
        const defaultPath = resolveSnapshotPath(built.ctx.roots, built.ctx.scope);
        return readSide(defaultPath, 'right');
      })();

  const changes = diffRaw(left.raw, right.raw);

  return {
    left: { source: left.source, path: left.path },
    right: { source: right.source, path: right.path },
    identical: changes.length === 0,
    changes,
  };
}

// -----------------------------------------------------------------------
// 8. configGet — a single resolved dot-path value plus its provenance
// -----------------------------------------------------------------------

/**
 * Resolves `project`'s environment live and returns the value at `field`
 * (a `SnapshotData.raw` dot-path key, e.g. `"server.port"`) plus its
 * `SnapshotData.provenance` entry — which cascade layer produced it
 * (`default`/`system`/`global`/`project`/`local`/`env`), and the env var
 * name when `source === 'env'`.
 *
 * CLI: adhd-env config-get <project> <specPath> <field> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>]
 */
export async function configGet(
  project: string,
  specPath: string,
  field: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
): Promise<ConfigGetResult> {
  const { loadSpecModule, buildAndMaybeWrite } = await import('./core.js');
  const spec = await loadSpecModule(specPath);
  const { data } = buildAndMaybeWrite(project, spec, {
    namespace: namespace || undefined,
    scope: (scope || undefined) as Scope | undefined,
    adhdRoot: adhdRoot || undefined,
    dryRun: true,
  });

  const found = Object.prototype.hasOwnProperty.call(data.raw, field);
  const provenanceEntry = data.provenance[field];

  return {
    project,
    field,
    found,
    value: found ? data.raw[field] : undefined,
    provenance: provenanceEntry ? { source: provenanceEntry.source, scope: provenanceEntry.scope, env: provenanceEntry.env } : null,
  };
}

// -----------------------------------------------------------------------
// 9. doctor — aggregate health check
// -----------------------------------------------------------------------

/**
 * Runs a fixed sequence of real, non-mocked health checks against
 * `project`'s spec module — spec loads, its scope resolves, the live
 * cascade builds, the resolved config validates against its generated JSON
 * Schema, a snapshot can be written to the resolved scope root, and that
 * snapshot can be read back — and reports a pass/fail summary.
 * `process.exitCode` is set to `1` when any check fails, so a real
 * generated CLI — or this process when driven as a script — exits
 * non-zero.
 *
 * CLI: adhd-env doctor <project> <specPath> [--namespace <ns>] [--scope <scope>] [--adhd-root <path>]
 */
export async function doctor(
  project: string,
  specPath: string,
  namespace = '',
  scope = '',
  adhdRoot = '',
): Promise<DoctorResult> {
  const { runDoctorChecks } = await import('./core.js');
  const report = await runDoctorChecks(project, specPath, {
    namespace: namespace || undefined,
    scope: (scope || undefined) as Scope | undefined,
    adhdRoot: adhdRoot || undefined,
  });

  if (!report.healthy) {
    process.exitCode = 1;
  }

  const passed = report.checks.filter((c) => c.passed).length;
  return {
    project,
    healthy: report.healthy,
    checks: report.checks,
    summary: `${passed}/${report.checks.length} checks passed`,
  };
}
