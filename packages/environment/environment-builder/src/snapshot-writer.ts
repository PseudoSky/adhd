/**
 * `snapshot-writer.ts` — Pipeline steps 15-16 + atomic persistence
 * (`[inv:atomic-write]`).
 *
 * Owns: resolving the on-disk snapshot path, resolving directory-catalog
 * entries to absolute paths, atomic `.tmp` + `renameSync` writes (directory
 * creation included), and drift detection between an existing on-disk
 * snapshot and a freshly-built one. `environment-snapshot.ts`
 * (`builder-snapshot-api`, a later state) orchestrates *calling* these
 * functions as part of the full 17-step `build()` pipeline; this module only
 * provides the pure/side-effecting primitives.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DirectoryEntry, ResolvedDirectoryEntry, SnapshotData } from '@adhd/environment-base-spec';

/** Filename of the written snapshot inside its resolved directory (see `environment-base-spec`'s `SNAPSHOT_FILENAME`). */
const SNAPSHOT_FILENAME = 'adhd-environment.json';

// ============================================================================
// Snapshot path resolution
// ============================================================================

/**
 * Resolves the on-disk snapshot path:
 * `<adhdRoot>/<orgNamespace>/<project>/<namespace>/adhd-environment.json`
 * (`[def:orgNamespace]`/`[def:namespace]`, `contexts/_shared.md`). The
 * namespace segment is always present — it defaults to `"default"` at the
 * `yaml-parser.ts` level, never omitted here.
 */
export function resolveConfigPath(
  adhdRoot: string,
  orgNamespace: string,
  project: string,
  namespace: string,
): string {
  return join(adhdRoot, orgNamespace, project, namespace, SNAPSHOT_FILENAME);
}

// ============================================================================
// Atomic write (`[inv:atomic-write]`)
// ============================================================================

export interface AtomicWriteOptions {
  /** POSIX file mode for the written file. Defaults to the platform default. */
  mode?: number;
}

/**
 * Atomically writes `data` (JSON-stringified unless already a string) to
 * `filePath`: creates the parent directory tree if needed, writes to
 * `<filePath>.tmp`, then `renameSync`s over `filePath`. `renameSync` on the
 * same filesystem is atomic — a reader can never observe a partially-written
 * file at `filePath` itself; at worst a stale `.tmp` is left behind if the
 * process is killed mid-write, never a truncated `filePath`.
 */
export function atomicWrite(filePath: string, data: unknown, opts: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const writeOptions: { encoding: BufferEncoding; mode?: number } = { encoding: 'utf8' };
  if (opts.mode !== undefined) writeOptions.mode = opts.mode;
  writeFileSync(tmpPath, serialized, writeOptions);
  renameSync(tmpPath, filePath);
}

// ============================================================================
// Step 15 — resolve directory catalog entries
// ============================================================================

export interface ResolveDirsContext {
  adhdRoot: string;
  orgNamespace: string;
  project: string;
  namespace: string;
  /** Used for `${PROJECT_ROOT}` interpolation in explicit `dir.path` values. Defaults to `process.cwd()`. */
  projectRoot?: string;
}

/**
 * Resolves each `DirectoryEntry` to an absolute path:
 *  - When `dir.path` is set, interpolates `$HOME`/`${HOME}`, `${PROJECT_ROOT}`,
 *    and `${NAMESPACE}` into it (per the `DirectoryEntry.path` doc comment in
 *    `environment-base-spec`).
 *  - When absent, auto-derives:
 *    `<adhdRoot>/<orgNamespace>/<project>/<namespace>/<scope>/<type>[/<name>]`.
 *  - `scope` defaults to `"project"` when not set on the entry.
 */
export function resolveDirs(dirs: DirectoryEntry[], ctx: ResolveDirsContext): ResolvedDirectoryEntry[] {
  return dirs.map((dir) => {
    const scope = dir.scope ?? 'project';
    const path = dir.path
      ? interpolateDirPath(dir.path, ctx)
      : join(ctx.adhdRoot, ctx.orgNamespace, ctx.project, ctx.namespace, scope, dir.type, dir.name ?? '');
    return {
      type: dir.type,
      name: dir.name,
      path,
      scope,
    };
  });
}

function interpolateDirPath(path: string, ctx: ResolveDirsContext): string {
  return path
    .replace(/\$\{HOME\}/g, homedir())
    .replace(/\$HOME\b/g, homedir())
    .replace(/\$\{PROJECT_ROOT\}/g, ctx.projectRoot ?? process.cwd())
    .replace(/\$\{NAMESPACE\}/g, ctx.namespace);
}

// ============================================================================
// Step 16 — read existing snapshot + detect drift
// ============================================================================

/** Reads and parses an existing on-disk snapshot, or `null` if absent/corrupt. */
export function readExistingSnapshot(configPath: string): SnapshotData | null {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as SnapshotData;
  } catch {
    return null;
  }
}

export interface DriftResult {
  /** Directory keys (`type` or `type:name`) present in the new build but not the existing snapshot. */
  added: string[];
  /** Directory keys present in the existing snapshot but not the new build. */
  removed: string[];
  typeChanges: Array<{ key: string; from: string; to: string }>;
  scopeChanges: Array<{ key: string; from: string; to: string }>;
}

/** Thrown when drift detection finds a `type` or `scope` change for an existing directory key — never for pure add/remove (those are warnings, not errors). */
export class DriftError extends Error {
  constructor(readonly drift: DriftResult) {
    super(
      `Directory drift detected: ${drift.typeChanges.length} type change(s), ${drift.scopeChanges.length} scope change(s). ` +
        `Type/scope changes to an existing directory catalog entry are not auto-migrated — resolve manually.`,
    );
    this.name = 'DriftError';
  }
}

/** Thrown when an existing snapshot at `configPath` belongs to a different project than the one being built — refuses to silently overwrite. */
export class NamespaceConflictError extends Error {
  constructor(existingProject: string, nextProject: string, configPath: string) {
    super(
      `Namespace conflict at "${configPath}": existing snapshot belongs to project "${existingProject}", ` +
        `refusing to overwrite with project "${nextProject}".`,
    );
    this.name = 'NamespaceConflictError';
  }
}

/**
 * The *identity* key used to match a directory entry across two builds for
 * drift purposes. Deliberately NOT `type` (or `type:name`) — `type` is the
 * very field a "type change" must be detected on, so it cannot also be part
 * of the matching key (a changed `type` would just look like an add+remove
 * of two different keys, never a `typeChange`). Instead:
 *  - `name` is the identity when set — it is the stable, user-chosen
 *    disambiguator and is expected to be invariant across a `type`/`scope`
 *    edit to the same logical directory entry.
 *  - When `name` is absent, the declaration's position (`index`) is the
 *    identity — the closest available stand-in for "the same entry" for an
 *    anonymous (name-less) directory.
 */
function dirKey(dir: { name?: string }, index: number): string {
  return dir.name ? `name:${dir.name}` : `index:${index}`;
}

/**
 * Compares an existing snapshot's resolved `dirs` against a freshly-resolved
 * `dirs` array, matching entries by `name` (or positional index when `name`
 * is absent — see `dirKey`).
 *
 * - `added`/`removed` — directories present in one side but not the other
 *   (caller should *warn*, not throw).
 * - `typeChanges`/`scopeChanges` — the same key resolved to a different
 *   `type`/`scope` across builds (caller should *throw* —
 *   `DriftError`).
 */
export function detectDrift(
  existingDirs: ResolvedDirectoryEntry[],
  nextDirs: ResolvedDirectoryEntry[],
): DriftResult {
  const existingByKey = new Map(existingDirs.map((dir, index) => [dirKey(dir, index), dir]));
  const nextByKey = new Map(nextDirs.map((dir, index) => [dirKey(dir, index), dir]));

  const added: string[] = [];
  const typeChanges: Array<{ key: string; from: string; to: string }> = [];
  const scopeChanges: Array<{ key: string; from: string; to: string }> = [];

  for (const [key, nextDir] of nextByKey) {
    const existingDir = existingByKey.get(key);
    if (!existingDir) {
      added.push(key);
      continue;
    }
    if (existingDir.type !== nextDir.type) {
      typeChanges.push({ key, from: existingDir.type, to: nextDir.type });
    }
    if (existingDir.scope !== nextDir.scope) {
      scopeChanges.push({ key, from: existingDir.scope, to: nextDir.scope });
    }
  }

  const removed: string[] = [];
  for (const key of existingByKey.keys()) {
    if (!nextByKey.has(key)) removed.push(key);
  }

  return { added, removed, typeChanges, scopeChanges };
}

/** Throws `NamespaceConflictError` if `existingSnapshot` belongs to a different project than `nextProjectName`. No-op if there is no existing snapshot. */
export function assertNoNamespaceConflict(
  existingSnapshot: Pick<SnapshotData, 'project'> | null,
  nextProjectName: string,
  configPath: string,
): void {
  if (existingSnapshot && existingSnapshot.project.name !== nextProjectName) {
    throw new NamespaceConflictError(existingSnapshot.project.name, nextProjectName, configPath);
  }
}
