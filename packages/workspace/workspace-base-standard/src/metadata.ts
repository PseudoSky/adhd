/**
 * metadata.ts — per-package metadata block for the (new) `<pkg>/.adhd/meta.json` file.
 *
 * This file does not exist anywhere in the monorepo yet (grep-confirmed
 * against `packages/**\/.adhd/meta.json` at authoring time) — this module
 * defines its shape and read/validate primitives so packages can start
 * adopting it.
 *
 * Field names (`group`, `kind`) deliberately match the REAL
 * `.adhd/workspace.json` vocabulary (`groups`, `kinds` — see
 * {@link WorkspaceTaxonomy}), not `SCOPE.md`'s `area`/`group` naming. This is
 * an explicit architect decision: one vocabulary, not two.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceTaxonomy } from './taxonomy';

/**
 * Per-package metadata block, stored at `<pkgDir>/.adhd/meta.json`.
 */
export interface PackageMeta {
  /** Must be a key of the workspace taxonomy's `groups`. */
  group: string;
  /** Must be a key of the workspace taxonomy's `kinds`. */
  kind: string;
  /** Free-text list of the concerns/responsibilities this package owns. */
  concerns: string[];
  /** Free-text list of invariants this package guarantees to callers. */
  invariants: string[];
  /** Relative paths (from the package root) of its public entrypoints. */
  entrypoints: string[];
}

const META_RELATIVE_PATH = '.adhd/meta.json';

/**
 * Reads `<pkgDir>/.adhd/meta.json`. Returns `null` if the file does not
 * exist (metadata is opt-in per package, not yet mandatory repo-wide).
 *
 * @throws if the file exists but is not valid JSON — a malformed metadata
 * file should fail loudly, not be silently treated as absent.
 */
export function readPackageMeta(pkgDir: string): PackageMeta | null {
  const metaPath = join(pkgDir, META_RELATIVE_PATH);
  if (!existsSync(metaPath)) return null;
  const raw = readFileSync(metaPath, 'utf-8');
  try {
    return JSON.parse(raw) as PackageMeta;
  } catch (err) {
    throw new Error(`Package metadata at ${metaPath} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Validates a {@link PackageMeta} block against the workspace taxonomy.
 * Returns an array of human-readable error strings; an empty array means
 * the metadata is valid.
 */
export function validatePackageMeta(meta: PackageMeta, taxonomy: WorkspaceTaxonomy): string[] {
  const errors: string[] = [];

  if (!meta.group || !(meta.group in taxonomy.groups)) {
    const known = Object.keys(taxonomy.groups).join(', ');
    errors.push(`Unknown group "${meta.group}". Known groups: ${known}.`);
  }

  if (!meta.kind || !(meta.kind in taxonomy.kinds)) {
    const known = Object.keys(taxonomy.kinds).join(', ');
    errors.push(`Unknown kind "${meta.kind}". Known kinds: ${known}.`);
  }

  return errors;
}
