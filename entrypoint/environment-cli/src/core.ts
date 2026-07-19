/**
 * `core.ts` — shared implementation for `@adhd/environment-cli`'s 5
 * commands (`init`/`build`/`set`/`status`/`export`) against the
 * redesigned, code-first `@adhd/environment` (`packages/environment/ARCHITECTURE.md`).
 *
 * The old CLI (pre-redesign) operated on a project-agnostic
 * `adhd.environment.yaml` spec file + a JSON key/value "store". Neither
 * concept exists in the redesign: a project's `EnvironmentSpec<T>` is now a
 * plain TypeScript/JavaScript value defined IN CODE by that project (see
 * `entrypoint/agent-mcp/src/config.ts`'s `agentMcpEnvironmentSpec` for the
 * reference consumer). This CLI is explicitly demoted to a THIN, OPTIONAL
 * wrapper (`ARCHITECTURE.md` §4) — it is never required for a consumer to
 * run — so it operates generically on ANY project's spec by dynamically
 * `import()`-ing a compiled JS/MJS module that exports one (named `spec` or
 * `default`), rather than re-inventing a parallel YAML spec format.
 *
 * The builder engine (`@adhd/environment-builder`) owns all resolve/
 * validation/hashing/persistence logic; this file only orchestrates it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { EnvironmentSpec, Scope, SnapshotData } from '@adhd/environment-base-spec';
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from '@adhd/environment-base-spec';
import {
  buildSnapshot,
  resolveEnvironmentContext,
  resolveSnapshotPath,
  rootForScope,
  validateConfig,
  writeSnapshot,
  type EnvironmentContext,
} from '@adhd/environment-builder';

export { resolveSnapshotPath };

// ---------------------------------------------------------------------------
// Spec module loading (replaces the old `parseYamlSpec`)
// ---------------------------------------------------------------------------

/**
 * Dynamically imports `specPath` (a compiled `.js`/`.mjs` module — CLI
 * tooling cannot execute a bare `.ts` file without a project-specific
 * loader) and returns its exported `EnvironmentSpec`. The module must
 * export either a named `spec` or a `default` binding.
 *
 * @throws if the file does not exist, fails to import, or does not export a
 *   recognizable `EnvironmentSpec` (an object with a `config` field).
 */
export async function loadSpecModule(specPath: string): Promise<EnvironmentSpec> {
  const absolute = resolvePath(specPath);
  if (!existsSync(absolute)) {
    throw new Error(`Spec module not found: ${absolute}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(pathToFileURL(absolute).href);
  const spec = (mod.spec ?? mod.default) as EnvironmentSpec | undefined;
  if (!spec || typeof spec !== 'object' || typeof spec.config !== 'object') {
    throw new Error(
      `Module at ${absolute} does not export a valid EnvironmentSpec ` +
        `(expected a named "spec" or "default" export with a "config" field)`,
    );
  }
  return spec;
}

// ---------------------------------------------------------------------------
// build — resolve + optionally persist a snapshot
// ---------------------------------------------------------------------------

export interface BuildOptions {
  namespace?: string;
  scope?: Scope;
  adhdRoot?: string;
  cwd?: string;
  dryRun?: boolean;
}

export interface BuiltSnapshot {
  data: SnapshotData;
  ctx: EnvironmentContext;
  snapshotPath: string;
}

/** Resolves `project` + `spec` into a fully-resolved `SnapshotData`, and
 *  (unless `dryRun`) atomically persists it via `writeSnapshot`. */
export function buildAndMaybeWrite(project: string, spec: EnvironmentSpec, opts: BuildOptions = {}): BuiltSnapshot {
  const data = buildSnapshot(project, spec, opts);
  const ctx = resolveEnvironmentContext(project, spec, opts);
  const snapshotPath = opts.dryRun ? '' : writeSnapshot(data, ctx.roots);
  return { data, ctx, snapshotPath };
}

// ---------------------------------------------------------------------------
// set — merge one field override into the active scope's config.yaml layer
// ---------------------------------------------------------------------------

/** Sets `dotPath` to `value` inside a nested plain-object tree, creating
 *  intermediate objects as needed (mirrors `environment-builder`'s
 *  `unflatten`, but merges into an EXISTING tree rather than building a
 *  fresh one — sibling keys are preserved). */
export function setNestedPath(root: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segments = dotPath.split('.');
  let node = root;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      node[segment] = value;
      return;
    }
    const existing = node[segment];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  });
}

/** Best-effort YAML-coerce a CLI string value against a field's declared
 *  `FieldSpec.type` (integers/booleans/arrays arrive as strings from argv). */
function coerceForYaml(value: string, type: string | undefined): unknown {
  switch (type) {
    case 'integer': {
      const n = parseInt(value, 10);
      return Number.isNaN(n) ? value : n;
    }
    case 'number': {
      const n = parseFloat(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    case 'array':
      return value.length === 0 ? [] : value.split(',').map((s) => s.trim());
    default:
      return value;
  }
}

export interface SetOptions {
  namespace?: string;
  scope?: Scope;
  adhdRoot?: string;
  cwd?: string;
  /** Write to the `local` (`config.local.yaml`) layer instead of `config.yaml`. */
  local?: boolean;
}

export interface LayerWriteResult {
  filePath: string;
  scope: Scope;
  field: string;
  value: unknown;
}

/**
 * Merges `{ [fieldPath]: value }` into the resolved scope's config layer
 * file (`config.yaml`, or `config.local.yaml` when `opts.local`), preserving
 * every other key already present. Creates the file (and its directory
 * tree) if absent. This is the redesign's direct replacement for the
 * pre-redesign `.adhd-store.json` — an actual cascade layer file that
 * `environment-builder`'s `loadLayerFiles` reads natively, not a
 * side-channel store the builder had to special-case.
 */
export function setLayerValue(
  project: string,
  spec: EnvironmentSpec,
  fieldPath: string,
  rawValue: string,
  opts: SetOptions = {},
): LayerWriteResult {
  const ctx = resolveEnvironmentContext(project, spec, opts);
  const scope = opts.scope ?? ctx.scope;
  const root = rootForScope(ctx.roots, scope);
  const filename = opts.local ? LOCAL_CONFIG_FILENAME : CONFIG_FILENAME;
  const filePath = join(root, filename);

  const existing: Record<string, unknown> = (() => {
    if (!existsSync(filePath)) return {};
    try {
      const parsed: unknown = parseYaml(readFileSync(filePath, 'utf8'));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  })();

  const fieldSpec = spec.config[fieldPath];
  const value = coerceForYaml(rawValue, fieldSpec?.type);
  setNestedPath(existing, fieldPath, value);

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, stringifyYaml(existing), 'utf8');

  return { filePath, scope, field: fieldPath, value };
}

// ---------------------------------------------------------------------------
// status — read-back what a snapshot on disk (if any) currently holds
// ---------------------------------------------------------------------------

export interface ReadSnapshotResult {
  path: string;
  exists: boolean;
  data: SnapshotData | null;
}

/** Reads a previously-`.write()`-persisted snapshot from `snapshotPath`
 *  without running the builder pipeline. Returns `exists: false` (never
 *  throws) when absent or corrupt — a missing snapshot is a normal,
 *  zero-config state, not an error. */
export function readSnapshotFile(snapshotPath: string): ReadSnapshotResult {
  if (!existsSync(snapshotPath)) return { path: snapshotPath, exists: false, data: null };
  try {
    const data = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotData;
    return { path: snapshotPath, exists: true, data };
  } catch {
    return { path: snapshotPath, exists: false, data: null };
  }
}

// ---------------------------------------------------------------------------
// diffRaw — shared flat dot-path comparison (verify + diff)
// ---------------------------------------------------------------------------

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  /** Dot-path field name (`SnapshotData.raw` key). */
  field: string;
  kind: DiffKind;
  /** Present for `'removed'`/`'changed'`. */
  before?: unknown;
  /** Present for `'added'`/`'changed'`. */
  after?: unknown;
}

/**
 * Compares two flat `SnapshotData.raw` maps (dot.path → value) and returns
 * every field that differs, sorted by field name for deterministic output.
 * Deep-equality is by `JSON.stringify` (raw values are JSON-Schema-typed
 * primitives/arrays, never functions/symbols/circular structures). Shared
 * by `verifySnapshot` (fresh build vs. persisted snapshot) and `diff`
 * (arbitrary snapshot/build pair).
 */
export function diffRaw(before: Record<string, unknown>, after: Record<string, unknown>): DiffEntry[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const entries: DiffEntry[] = [];
  for (const field of Array.from(keys).sort()) {
    const hasBefore = Object.prototype.hasOwnProperty.call(before, field);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, field);
    if (hasBefore && !hasAfter) {
      entries.push({ field, kind: 'removed', before: before[field] });
    } else if (!hasBefore && hasAfter) {
      entries.push({ field, kind: 'added', after: after[field] });
    } else if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      entries.push({ field, kind: 'changed', before: before[field], after: after[field] });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// verify — diff a fresh live-resolve against the persisted snapshot
// ---------------------------------------------------------------------------

export interface VerifyOutcome {
  project: string;
  namespace: string;
  scope: Scope;
  snapshotPath: string;
  snapshotExisted: boolean;
  drift: DiffEntry[];
}

/**
 * Resolves `spec` live (same cascade `Environment` uses) and diffs its
 * `raw` against whatever `.write()`-persisted snapshot (if any) currently
 * sits at the resolved scope's `adhd-environment.json`. A missing snapshot
 * is reported via `snapshotExisted: false` (not itself a `DiffEntry`) — the
 * caller (`api.verify`) decides whether "no snapshot to verify against" is
 * itself a failure.
 */
export function verifySnapshot(project: string, spec: EnvironmentSpec, opts: BuildOptions = {}): VerifyOutcome {
  const fresh = buildSnapshot(project, spec, opts);
  const ctx = resolveEnvironmentContext(project, spec, opts);
  const snapshotPath = resolveSnapshotPath(ctx.roots, ctx.scope);
  const onDisk = readSnapshotFile(snapshotPath);
  const drift = onDisk.exists && onDisk.data ? diffRaw(onDisk.data.raw, fresh.raw) : [];
  return {
    project,
    namespace: ctx.namespace,
    scope: ctx.scope,
    snapshotPath,
    snapshotExisted: onDisk.exists,
    drift,
  };
}

// ---------------------------------------------------------------------------
// doctor — aggregate health check
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  healthy: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs a fixed sequence of real (non-mocked) health checks against a
 * project's spec module — spec module loads, its declared scope resolves,
 * the live cascade builds, the resolved config validates against its
 * generated JSON Schema, a snapshot can be written to the resolved scope
 * root, and that snapshot can be read back. Each check is isolated: a
 * failure in an earlier check short-circuits the checks that depend on its
 * output (recorded as `passed: false` with a "skipped" message) rather than
 * throwing and losing the rest of the report — the whole point of `doctor`
 * is a single aggregate report, never a crash on the first bad field.
 */
export async function runDoctorChecks(project: string, specPath: string, opts: BuildOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let spec: EnvironmentSpec | undefined;

  try {
    spec = await loadSpecModule(specPath);
    checks.push({ name: 'spec-loads', passed: true, message: `Loaded spec module from ${resolvePath(specPath)}` });
  } catch (err) {
    checks.push({ name: 'spec-loads', passed: false, message: errorMessage(err) });
  }

  if (!spec) {
    for (const name of ['scope-resolves', 'builds', 'validates', 'snapshot-writable', 'snapshot-readable']) {
      checks.push({ name, passed: false, message: 'skipped: spec module did not load' });
    }
    return { checks, healthy: false };
  }

  let ctx: EnvironmentContext | undefined;
  try {
    ctx = resolveEnvironmentContext(project, spec, opts);
    checks.push({
      name: 'scope-resolves',
      passed: true,
      message: `Resolved scope "${ctx.scope}" (namespace "${ctx.namespace}")`,
    });
  } catch (err) {
    checks.push({ name: 'scope-resolves', passed: false, message: errorMessage(err) });
  }

  let data: SnapshotData | undefined;
  try {
    data = buildSnapshot(project, spec, opts);
    checks.push({ name: 'builds', passed: true, message: `Resolved ${Object.keys(data.raw).length} field(s)` });
  } catch (err) {
    checks.push({ name: 'builds', passed: false, message: errorMessage(err) });
  }

  if (data) {
    try {
      // `buildSnapshot` already validates internally (it would have thrown
      // above on violation); re-running it explicitly here against the
      // final resolved `config` gives `doctor` its own independently
      // reported "validates" check rather than conflating it with "builds".
      validateConfig(data.config as Record<string, unknown>, data.fieldSchema);
      checks.push({ name: 'validates', passed: true, message: 'Resolved config satisfies the generated field schema' });
    } catch (err) {
      checks.push({ name: 'validates', passed: false, message: errorMessage(err) });
    }
  } else {
    checks.push({ name: 'validates', passed: false, message: 'skipped: build failed' });
  }

  if (data && ctx) {
    let snapshotPath = '';
    try {
      snapshotPath = writeSnapshot(data, ctx.roots);
      checks.push({ name: 'snapshot-writable', passed: true, message: `Wrote snapshot to ${snapshotPath}` });
    } catch (err) {
      checks.push({ name: 'snapshot-writable', passed: false, message: errorMessage(err) });
    }

    if (snapshotPath) {
      const readBack = readSnapshotFile(snapshotPath);
      if (readBack.exists && readBack.data && readBack.data.configHash === data.configHash) {
        checks.push({ name: 'snapshot-readable', passed: true, message: `Read back snapshot from ${snapshotPath}` });
      } else {
        checks.push({
          name: 'snapshot-readable',
          passed: false,
          message: `Read back from ${snapshotPath} did not match the snapshot just written`,
        });
      }
    } else {
      checks.push({ name: 'snapshot-readable', passed: false, message: 'skipped: snapshot not written' });
    }
  } else {
    checks.push({ name: 'snapshot-writable', passed: false, message: 'skipped: build or scope resolution failed' });
    checks.push({ name: 'snapshot-readable', passed: false, message: 'skipped: build or scope resolution failed' });
  }

  return { checks, healthy: checks.every((c) => c.passed) };
}

// ---------------------------------------------------------------------------
// init — scaffold a starter code-first spec module
// ---------------------------------------------------------------------------

const DEFAULT_SPEC_TEMPLATE = `/**
 * Starter @adhd/environment spec — scaffolded by \`adhd-env init\`.
 *
 * This is CODE, not YAML (the redesign is code-first — see
 * packages/environment/ARCHITECTURE.md §0/§2.1). Import \`Environment\` from
 * "@adhd/environment" and construct it directly in your own entrypoint:
 *
 *   import { Environment } from "@adhd/environment";
 *   import { spec } from "./adhd.environment.spec.mjs";
 *   export const env = new Environment("my-project", spec);
 *
 * This file is also consumable by \`adhd-env build/set/status/export\`
 * (they dynamically import it and read the "spec" export below).
 */
export const spec = {
  // orgNamespace: "adhd",
  // namespaces: ["default"],
  dirs: {
    data: { kind: "data" },
  },
  config: {
    // "server.port": { type: "integer", default: 3000 },
  },
};
`;

export interface InitResult {
  success: boolean;
  path: string;
  template: string;
}

/** Scaffolds a starter spec module (`adhd.environment.spec.mjs`) in
 *  `targetDir` (defaults to `process.cwd()`). When `generateConfig` is
 *  `false`, returns the template without writing anything (dry-run/preview). */
export function initProject(generateConfig: boolean, targetDir: string = process.cwd()): InitResult {
  const targetPath = join(targetDir, 'adhd.environment.spec.mjs');
  if (generateConfig) {
    writeFileSync(targetPath, DEFAULT_SPEC_TEMPLATE, 'utf8');
  }
  return { success: generateConfig, path: targetPath, template: DEFAULT_SPEC_TEMPLATE };
}
