/**
 * taxonomy.ts — thin, nx-free reader for `.adhd/workspace.json`.
 *
 * This is deliberately NOT a second taxonomy format:
 * `.adhd/workspace.json` is already read by
 * `packages/workspace/workspace-codegen-nx/src/generators/shared/
 * workspace-config.ts` (via `@nx/devkit`'s `Tree`/`readJson` when
 * running inside a generator, or a raw `fs.readFileSync` fallback
 * otherwise). This module mirrors that exact shape via plain
 * `node:fs` + `JSON.parse` so it can be consumed from contexts that
 * must stay nx-free (CLI checkers, git hooks, tests) without pulling
 * in `@nx/devkit` as a dependency.
 *
 * The one addition over the existing `WorkspaceConfig` shape is the
 * optional `boundaries` field: new data that `PKG-WS-NX-ADAPTER` will
 * populate into `.adhd/workspace.json` (an Nx `depConstraints` matrix
 * keyed by tag). This package only reads and validates that shape —
 * it never authors the matrix.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A single Nx module-boundary dependency constraint, as consumed by
 * `@nx/enforce-module-boundaries`'s `depConstraints` option.
 */
export interface DepConstraint {
  sourceTag: string;
  onlyDependOnLibsWithTags?: string[];
  notDependOnLibsWithTags?: string[];
}

/**
 * Per-tier defaults block within `.adhd/workspace.json`.
 */
export interface WorkspaceTaxonomyDefaults {
  types?: {
    access?: string;
    publish?: boolean;
    nxLayer?: string;
    platform?: string;
  };
  entrypoint?: {
    nxLayer?: string;
    platform?: string;
    access?: string;
    publish?: boolean;
  };
  library?: { access?: string; publish?: boolean };
}

/**
 * The full `.adhd/workspace.json` shape, mirroring
 * `workspace-codegen-nx`'s `WorkspaceConfig` plus the new optional
 * `boundaries` field.
 */
export interface WorkspaceTaxonomy {
  scope: string;
  groups: Record<string, { description: string }>;
  kinds: Record<string, { class: string; description: string }>;
  platforms: Record<string, { description: string }>;
  layers: Record<string, { description: string }>;
  defaults: WorkspaceTaxonomyDefaults;
  /**
   * NEW: optional Nx module-boundary dependency-constraint matrix.
   * Populated by `PKG-WS-NX-ADAPTER`; read-only here.
   */
  boundaries?: {
    depConstraints: DepConstraint[];
  };
}

const CONFIG_RELATIVE_PATH = '.adhd/workspace.json';

/**
 * Reads and parses `.adhd/workspace.json` from `rootDir` (the
 * workspace root, i.e. the directory containing `.adhd/`). Pure
 * `node:fs`, no `@nx/devkit` import — safe to call from any Node
 * context.
 *
 * @throws if the file is missing or is not valid JSON. Callers that
 * want a "config is optional" fallback (as `workspace-config.ts`
 * does inside a generator) should catch and handle `null`/
 * `undefined` themselves; this function does not swallow errors,
 * since a checker/CLI context should fail loudly on a malformed
 * workspace config rather than silently skip validation.
 */
export function readTaxonomy(rootDir: string): WorkspaceTaxonomy {
  const configPath = join(rootDir, CONFIG_RELATIVE_PATH);
  if (!existsSync(configPath)) {
    throw new Error(`Workspace taxonomy not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = (err as Error).message;
    throw new Error(
      `Workspace taxonomy at ${configPath} is not valid JSON: ${reason}`
    );
  }
  return parsed as WorkspaceTaxonomy;
}
