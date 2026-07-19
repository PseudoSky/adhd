/**
 * `config-resolver.ts` — the field-value cascade (ARCHITECTURE.md §2.2):
 *
 *   code defaults → system file → global file → project file → local file → env vars
 *
 * Precedence, high→low: env var (remapped) > local file > project file >
 * global file > system file > spec default. Every layer is optional; the
 * spec default is the only layer guaranteed to be present, which is what
 * makes the whole cascade zero-config (ARCHITECTURE.md §0/§2.1).
 *
 * `at: 'runtime'` and `secret: true` fields are resolved into an *env-ref*
 * sentinel string (`makeEnvRef`) here rather than a plain value — the live,
 * per-access re-read of `process.env` happens one layer up, in
 * `environment-core-node`'s `Environment`, which installs a getter for every
 * env-ref leaf (see `ARCHITECTURE.md` §3.1 `FieldSpec.at`).
 *
 * Pure — no I/O (the already-loaded `Layers` and a caller-supplied
 * `processEnv` snapshot are passed in).
 */

import type { FieldSpec, ProvenanceEntry, ProvenanceSource, Scope } from '@adhd/environment-base-spec';
import { inferEnvVar, makeEnvRef } from '@adhd/environment-base-spec';

import type { Layers } from './layer-files';
import { buildProvenanceEntry } from './provenance';

/** A `FieldSpec` after env-name inference + fallback resolution. */
export interface ResolvedFieldSpec extends FieldSpec {
  /** The effective env var name (explicit `env` or inferred). */
  env: string;
  /** `true` when this field is always env-sourced at read time
   *  (`at: 'runtime'` or `secret: true`). */
  live: boolean;
  /** The value that would be used if the env var (live layer) were unset —
   *  i.e. the cascade result of just the file layers + spec default. Used
   *  by `environment-core-node` as a live-getter's fallback. */
  fallbackValue: unknown;
}

/**
 * Coerces a single (string-or-already-typed) value according to a field's
 * declared `type`. Invalid coercions (e.g. `"abc"` as `"integer"`) return
 * the original value unchanged — validation (via the generated JSON Schema)
 * is responsible for surfacing that as an error.
 */
export function coerceValue(value: unknown, type: FieldSpec['type']): unknown {
  if (value === undefined) return value;
  switch (type) {
    case 'integer': {
      if (typeof value === 'number') return value;
      const n = parseInt(String(value), 10);
      return Number.isNaN(n) ? value : n;
    }
    case 'number': {
      if (typeof value === 'number') return value;
      const n = parseFloat(String(value));
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const normalized = String(value).toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
      return value;
    }
    case 'array': {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        return value.length === 0 ? [] : value.split(',').map((entry) => entry.trim());
      }
      return value;
    }
    case 'string':
      return typeof value === 'string' ? value : String(value);
    default:
      return value;
  }
}

/** `{"db.path": "/tmp/db", "server.port": "3000"}` → `{db: {path: "/tmp/db"}, server: {port: "3000"}}`. */
export function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(flat)) {
    const segments = key.split('.');
    let node = result;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        node[segment] = flat[key];
        return;
      }
      const existing = node[segment];
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    });
  }
  return result;
}

export interface ResolveConfigContext {
  /** The project's resolved env prefix, e.g. `"ADHD_AGENT_MCP"`. */
  prefix: string;
  /** The active scope — recorded as the default provenance scope for a
   *  field that does not declare its own `FieldSpec.scope`. */
  activeScope: Scope;
}

export interface ResolveConfigResult {
  /** Flat dot-path field name → resolved value. A `live` field's value here
   *  is an env-ref sentinel (`makeEnvRef`), never the plaintext. */
  raw: Record<string, unknown>;
  /** `raw`, unflattened into a nested tree — the pre-live-getter shape of
   *  `SnapshotData.config` / `Environment#config`. */
  nested: Record<string, unknown>;
  /** Flat dot-path field name → the REAL, typed value (never env-ref
   *  redacted) — used only for JSON-Schema validation, so a `secret`/
   *  `at:'runtime'` field is validated against its actual type instead of
   *  the opaque env-ref sentinel string. Never persisted/exposed. */
  typedRaw: Record<string, unknown>;
  /** Flat dot-path field name → provenance entry. */
  provenance: Record<string, ProvenanceEntry>;
  /** Flat dot-path field name → resolved field metadata (env name, `live`,
   *  fallback value). */
  fields: Record<string, ResolvedFieldSpec>;
}

const FILE_LAYER_ORDER: ReadonlyArray<[keyof Layers, ProvenanceSource]> = [
  ['system', 'system'],
  ['global', 'global'],
  ['project', 'project'],
  ['local', 'local'],
];

/**
 * Resolves every declared field's effective value per the cascade
 * (ARCHITECTURE.md §2.2). `processEnv` is the (caller-supplied, testable)
 * environment snapshot consulted for the top ("env var") layer — the
 * *pure builder* only ever looks at this one static snapshot; the
 * "re-read live between two accesses" behavior for `live` fields is layered
 * on top by `environment-core-node`.
 */
export function resolveConfig(
  configSpec: Record<string, FieldSpec>,
  layers: Layers,
  processEnv: Record<string, string | undefined>,
  ctx: ResolveConfigContext,
): ResolveConfigResult {
  const raw: Record<string, unknown> = {};
  const typedRaw: Record<string, unknown> = {};
  const provenance: Record<string, ProvenanceEntry> = {};
  const fields: Record<string, ResolvedFieldSpec> = {};

  for (const key of Object.keys(configSpec)) {
    const field = configSpec[key];
    const envName = field.env && field.env !== '' ? field.env : inferEnvVar(ctx.prefix, key);
    const isLive = field.at === 'runtime' || field.secret === true;
    const fieldScope = field.scope ?? ctx.activeScope;

    // File-layer cascade (system → global → project → local), lowest to highest.
    let fallbackValue: unknown = field.default;
    let fallbackSource: ProvenanceSource = 'default';
    for (const [layerName, source] of FILE_LAYER_ORDER) {
      const layer = layers[layerName];
      if (layer && Object.prototype.hasOwnProperty.call(layer, key)) {
        fallbackValue = coerceValue(layer[key], field.type);
        fallbackSource = source;
      }
    }

    const liveEnvValue = processEnv[envName];
    let value: unknown;
    let source: ProvenanceSource;
    let recordedEnv: string | undefined;
    if (liveEnvValue !== undefined) {
      value = coerceValue(liveEnvValue, field.type);
      source = 'env';
      recordedEnv = envName;
    } else {
      value = fallbackValue;
      source = fallbackSource;
    }

    raw[key] = isLive ? makeEnvRef(envName) : value;
    typedRaw[key] = value;
    provenance[key] = isLive
      ? buildProvenanceEntry({ source: 'env', scope: fieldScope, env: envName })
      : buildProvenanceEntry({ source, scope: fieldScope, env: recordedEnv });
    fields[key] = { ...field, env: envName, live: isLive, fallbackValue };
  }

  return { raw, nested: unflatten(raw), typedRaw, provenance, fields };
}
