/**
 * `snapshot.ts` — the top-level pure-resolve orchestrator
 * (`buildSnapshot`) and the optional on-disk persistence entrypoint
 * (`writeSnapshot`), per ARCHITECTURE.md §4.
 *
 * `buildSnapshot` has NO disk-read prerequisite (ARCHITECTURE.md §2.1):
 * everything it reads (layer files, `process.env`) is optional, and the
 * spec's `default`s guarantee a fully-resolved result even when nothing is
 * on disk. It is called once, synchronously, at `Environment` construction.
 */

import { randomBytes } from 'node:crypto';
import type { EnvironmentOptions, EnvironmentSpec, LiveFieldMeta, Scope, SnapshotData } from '@adhd/environment-base-spec';
import {
  DEFAULT_NAMESPACE,
  DEFAULT_ORG_NAMESPACE,
  SPEC_VERSION,
  contentHash,
  generateFieldSchema,
  projectEnvPrefix,
  structureHash,
} from '@adhd/environment-base-spec';

import { resolveConfig, unflatten } from './config-resolver';
import { resolveDirs, resolveFiles } from './dirs';
import { loadLayerFiles } from './layer-files';
import { resolveRoots } from './roots';
import type { Roots } from './roots';
import { resolveScope } from './scope';
import { atomicWrite, resolveSnapshotPath } from './snapshot-writer';
import { validateConfig } from './validation';

/** Library version stamped into every snapshot's `libraryVersion` field.
 *  Mirrors this package's `package.json#version`. Duplicated as a literal
 *  (not `require()`d) so it is stable across the built package. */
const LIBRARY_VERSION = '0.1.0';

/** Rejects a `project`/`namespace` segment that could escape a resolved
 *  root when interpolated into a filesystem path. */
function validatePathSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(
      `${label} must be a non-empty path segment with no '.', '..', path separators, or NUL: ${JSON.stringify(segment)}`,
    );
  }
}

/** `pid + short random` — unique per constructed `Environment` instance
 *  (ARCHITECTURE.md §3.2 `env.instanceId`). */
export function generateInstanceId(): string {
  return `${process.pid}-${randomBytes(3).toString('hex')}`;
}

export interface BuildSnapshotOptions extends EnvironmentOptions {
  /** Overrides `process.env` for the "env var" cascade layer. Defaults to
   *  `process.env`. Exposed for pure-function testability; production
   *  callers should leave this unset. */
  processEnv?: Record<string, string | undefined>;
}

/** The identity + root resolution shared by `buildSnapshot` and
 *  `environment-core-node`'s `Environment` (for `write()`/`lock()`, which
 *  need the active scope's root without re-running the whole cascade). */
export interface EnvironmentContext {
  project: string;
  namespace: string;
  orgNamespace: string;
  envPrefix: string;
  scope: Scope;
  projectRoot?: string;
  roots: Roots;
}

/**
 * Resolves a project + spec + options down to its identity (namespace/
 * org/env-prefix) and directory roots — the portion of `buildSnapshot`'s
 * work that `Environment` also needs independently for `write()`/`lock()`.
 * Pure and cheap; safe to call more than once for the same inputs.
 */
export function resolveEnvironmentContext(
  project: string,
  spec: Pick<EnvironmentSpec, 'orgNamespace' | 'envPrefixOverride' | 'namespaces'>,
  options: EnvironmentOptions & { processEnv?: Record<string, string | undefined> } = {},
): EnvironmentContext {
  if (!project) throw new Error("Environment requires a non-empty 'project' name");
  validatePathSegment(project, 'project');

  const orgNamespace = spec.orgNamespace ?? DEFAULT_ORG_NAMESPACE;
  const envPrefix = spec.envPrefixOverride ?? projectEnvPrefix(project);
  const namespaces = spec.namespaces && spec.namespaces.length > 0 ? spec.namespaces : [DEFAULT_NAMESPACE];
  const namespace = options.namespace ?? namespaces[0];
  if (!namespaces.includes(namespace)) {
    throw new Error(
      `Namespace "${namespace}" is not declared for project "${project}" (declared: ${namespaces.join(', ')})`,
    );
  }
  validatePathSegment(namespace, 'namespace');

  const processEnv = options.processEnv ?? process.env;
  const { scope, projectRoot } = resolveScope({ scope: options.scope, cwd: options.cwd }, processEnv);
  const roots = resolveRoots({ project, namespace, orgNamespace, projectRoot, adhdRoot: options.adhdRoot });

  return { project, namespace, orgNamespace, envPrefix, scope, projectRoot, roots };
}

/**
 * The single pure-resolve entrypoint: turns a code-defined `EnvironmentSpec`
 * + `EnvironmentOptions` into a fully-resolved `SnapshotData<T>`, live, in
 * memory, synchronously — see ARCHITECTURE.md §2.1/§4.
 */
export function buildSnapshot<T = Record<string, unknown>>(
  project: string,
  spec: EnvironmentSpec<T>,
  options: BuildSnapshotOptions = {},
): SnapshotData<T> {
  const { namespace, orgNamespace, envPrefix, scope, projectRoot, roots } = resolveEnvironmentContext(
    project,
    spec,
    options,
  );

  const processEnv = options.processEnv ?? process.env;
  const layers = loadLayerFiles(roots);
  const instanceId = options.instanceId ?? generateInstanceId();

  const { raw, nested, typedRaw, provenance, fields } = resolveConfig(spec.config, layers, processEnv, {
    prefix: envPrefix,
    activeScope: scope,
  });

  const liveFields: Record<string, LiveFieldMeta> = {};
  for (const key of Object.keys(fields)) {
    const field = fields[key];
    if (field.live) {
      // SECURITY: a `secret: true` field NEVER carries a persisted fallback
      // — `SnapshotData` (and therefore `liveFields`) is a `.write()`-able,
      // on-disk artifact, and a plaintext credential placed in `default`/a
      // file layer must never round-trip through it. When the live env var
      // is unset, a secret field's getter resolves to `undefined`, full
      // stop. A non-secret `at:'runtime'` field is not credential-shaped —
      // its (already validated, non-sensitive) fallback is safe to persist.
      liveFields[key] = { env: field.env, type: field.type, fallback: field.secret === true ? undefined : field.fallbackValue };
    }
  }

  const fieldSchema = generateFieldSchema(spec.config);
  // Validate the REAL, unflattened, typed values (never the env-ref-redacted
  // `nested`/`raw` shape) — a secret/at:'runtime' field's schema type (e.g.
  // "integer") must be checked against its actual value, not the opaque
  // "adhd-env-ref:..." sentinel string that would otherwise fail validation.
  validateConfig(unflatten(typedRaw), fieldSchema);

  const resolvedDirs = resolveDirs(spec.dirs, { roots, activeScope: scope, instanceId, projectRoot, namespace });
  const resolvedFiles = resolveFiles(spec.files, resolvedDirs);

  const data: SnapshotData<T> = {
    version: SPEC_VERSION,
    libraryVersion: LIBRARY_VERSION,
    generatedAt: new Date().toISOString(),
    project,
    namespace,
    orgNamespace,
    envPrefix,
    scope,
    instanceId,
    config: nested as T,
    raw,
    liveFields,
    fieldSchema,
    configHash: contentHash(Object.fromEntries(Object.entries(typedRaw).map(([k, v]) => [k, String(v)]))),
    structureHash: structureHash(Object.values(resolvedDirs).map((d) => ({ name: d.name, kind: d.kind, scope: d.scope }))),
    dirs: Object.values(resolvedDirs),
    files: Object.values(resolvedFiles),
    provenance,
  };

  return data;
}

/**
 * Persists `data` to `<root-for-data.scope>/adhd-environment.json`
 * (`Environment#write()`, ARCHITECTURE.md §3.2). Optional, atomic — never a
 * read prerequisite for any other `Environment` instance.
 */
export function writeSnapshot(data: SnapshotData, roots: Parameters<typeof resolveSnapshotPath>[0]): string {
  const path = resolveSnapshotPath(roots, data.scope);
  atomicWrite(path, data);
  return path;
}
