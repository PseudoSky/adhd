/**
 * `config-resolver.ts` — Pipeline steps 5-11 (load store, infer env names,
 * resolve values, interpolate, unflatten, coerce).
 *
 * NOTE on cross-package imports: this module only ever imports *types* from
 * `@adhd/environment-base-spec` (`import type { ... }`), which TypeScript's
 * (and Node's native) type-stripping erases completely — no runtime module
 * resolution is attempted for them. Any *value* this module needs from the
 * cross-language contract (`inferEnvVar`) is duplicated locally instead of
 * imported at runtime, because this package has no `node_modules/@adhd/*`
 * workspace symlinks: `@adhd/environment-base-spec` only resolves via the
 * Nx/Vite tsconfig path alias (used by `nx build`), not via plain
 * `node -e require(...)` of the raw `.ts` source (used directly by this
 * plan's acceptance criteria). The algorithm is pinned identically in both
 * places by `[def:inferEnvVar]` in `contexts/_shared.md`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigFieldDefinition, ConfigScope, ProvenanceSource } from '@adhd/environment-base-spec';

// ============================================================================
// Step 6 — infer env var names
// ============================================================================

/**
 * `inferEnvVar("ADHD_AGENT_MCP", "db.path")` → `"ADHD_AGENT_MCP_DB_PATH"`.
 * See `[def:inferEnvVar]` in `contexts/_shared.md`.
 */
export function inferEnvVar(prefix: string, fieldPath: string): string {
  return `${prefix}_${fieldPath.toUpperCase().replace(/[.-]/g, '_')}`;
}

/** Reserved prefix marking a redacted secret reference. Duplicated from
 *  `@adhd/environment-base-spec`'s `SECRET_REF_PREFIX` (this module imports
 *  only *types* from the base-spec at runtime — see the file header — so the
 *  value is pinned identically here, exactly as `inferEnvVar` is). */
export const SECRET_REF_PREFIX = 'adhd-secret-ref:';

// ============================================================================
// Secret redaction (`[inv:no-plaintext-secrets]`, ENV-CORE-009)
// ============================================================================

/**
 * Replaces every `secret: true` field's resolved value in a flat dot-path
 * map with a *reference* — `"adhd-secret-ref:<ENV_VAR>"` — so the plaintext
 * credential is NEVER persisted to `adhd-environment.json`. The runtime
 * client (`Environment.get`) resolves the live value from the environment at
 * read time. Non-secret fields pass through unchanged.
 *
 * The env-var name used is the field's finalized effective `env` (the
 * explicit override or the inferred name), as produced by `resolveConfig`.
 * This is the canonical pre-persistence transform: build the snapshot's
 * `raw` (and, via `unflatten`, its nested `config`) from the OUTPUT of this
 * function, and compute `configHash` over the redacted `raw` so the hash is
 * stable and never depends on a secret's plaintext.
 *
 * Note: a `noEnv` secret (one that can only come from the `adhd-env set`
 * store / default) has no env source to resolve from at read time; its value
 * is still redacted here (never leaked) but will read back as unset. See
 * BACKLOG ENV-CORE-012.
 */
export function redactSecrets(
  raw: Record<string, unknown>,
  fields: Record<string, ConfigFieldDefinition>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const field = fields[key];
    if (field?.secret === true) {
      const envName = field.env && field.env !== '' ? field.env : inferEnvVar('ADHD', key);
      out[key] = `${SECRET_REF_PREFIX}${envName}`;
    } else {
      out[key] = raw[key];
    }
  }
  return out;
}

// ============================================================================
// Step 5 — load stored values (`adhd-env set` store)
// ============================================================================

/** Flat dot-path field name → stored string value (see interfaces-architect.md §8). */
export interface StoreValues {
  [fieldPath: string]: string;
}

interface StoreFile {
  version?: string;
  values?: StoreValues;
  updatedAt?: string;
}

/**
 * Reads the `adhd-env set` store for a given project + namespace. The store
 * lives at `<adhdRoot>/<orgNamespace>/<project>/<namespace>/.adhd-store.json`
 * (interfaces-architect.md §8). Missing or unreadable/corrupt store files are
 * treated as an empty store rather than an error — the store is optional
 * (fields fall through to env vars / defaults).
 */
export function readStore(
  adhdRoot: string,
  orgNamespace: string,
  project: string,
  namespace: string,
): StoreValues {
  const storePath = join(adhdRoot, orgNamespace, project, namespace, '.adhd-store.json');
  if (!existsSync(storePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile;
    return parsed.values ?? {};
  } catch {
    return {};
  }
}

// ============================================================================
// Steps 6-7 — resolve field values
// ============================================================================

/** The value + provenance metadata resolved for a single field (pre-`ProvenanceEntry` shape). */
export interface ResolvedFieldValue {
  value: unknown;
  source: ProvenanceSource;
  scope: ConfigScope;
  /** The env var name actually consulted, when `source` ends in `.env`/`.override`. */
  env?: string;
}

export interface ResolveConfigContext {
  /** The project's resolved env prefix (`[def:envPrefix]`), e.g. `"ADHD_AGENT_MCP"`. */
  prefix: string;
  /** The `adhd-env set` store (see `readStore`). Defaults to `{}`. */
  store?: StoreValues;
  /** Process environment to read from. Defaults to `process.env`. Overridable for tests. */
  processEnv?: Record<string, string | undefined>;
  /** When set, only fields whose effective scope matches are resolved. */
  scope?: ConfigScope;
}

export interface ResolveConfigResult {
  /** Flat dot-path field name → resolved (pre-interpolation, pre-coercion) value. */
  raw: Record<string, unknown>;
  /** Flat dot-path field name → resolution metadata (value + source + scope + env). */
  resolved: Record<string, ResolvedFieldValue>;
  /** `fields`, but with every `env` sentinel finalized to its effective env var name. */
  fields: Record<string, ConfigFieldDefinition>;
}

/**
 * Resolves every (optionally scope-filtered) field's effective value per
 * `[def:effectiveEnv]` (`contexts/_shared.md`):
 *
 *   `env var (inferred or override) → adhd-env set-store value → field default`
 *
 * `system`-scope fields are resolved from `default` only — they are
 * "framework-shipped defaults, rarely changed" (SPEC_0.0.4.md) and are the
 * only scope for which `ProvenanceSource` has no `.env`/`.set` variant.
 * `global`-scope fields resolve from env (inferred/overridden name) or
 * default — no per-project store lookup (the store is project+namespace
 * scoped). `project`-scope fields resolve from env, then store, then
 * default, and distinguish `"project.env"` (inferred name) from
 * `"project.override"` (explicit `env:` override in the field definition) —
 * see `ProvenanceEntry` doc comments in `environment-base-spec`.
 */
export function resolveConfig(
  fields: Record<string, ConfigFieldDefinition>,
  ctx: ResolveConfigContext,
): ResolveConfigResult {
  const store = ctx.store ?? {};
  const env = ctx.processEnv ?? process.env;

  const raw: Record<string, unknown> = {};
  const resolved: Record<string, ResolvedFieldValue> = {};
  const resolvedFields: Record<string, ConfigFieldDefinition> = {};

  for (const key of Object.keys(fields)) {
    const field = fields[key];
    if (ctx.scope !== undefined && field.scope !== ctx.scope) continue;

    const explicitOverride = field.env !== undefined && field.env !== '';
    const effectiveEnv = explicitOverride ? field.env : inferEnvVar(ctx.prefix, key);
    resolvedFields[key] = { ...field, env: effectiveEnv };

    let value: unknown;
    let source: ProvenanceSource;
    let recordedEnv: string | undefined;

    if (field.scope === 'system') {
      value = field.default;
      source = 'system.default';
    } else if (!field.noEnv && env[effectiveEnv] !== undefined) {
      value = env[effectiveEnv];
      recordedEnv = effectiveEnv;
      if (field.scope === 'project') {
        source = explicitOverride ? 'project.override' : 'project.env';
      } else {
        source = 'global.env';
      }
    } else if (field.scope === 'project' && Object.prototype.hasOwnProperty.call(store, key)) {
      value = store[key];
      source = 'project.set';
    } else {
      value = field.default;
      source = field.scope === 'global' ? 'global.default' : 'project.default';
    }

    raw[key] = value;
    resolved[key] = { value, source, scope: field.scope, env: recordedEnv };
  }

  return { raw, resolved, fields: resolvedFields };
}

// ============================================================================
// Step 9 — interpolate ${VAR} references (single-level only)
// ============================================================================

const INTERPOLATION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Single-level `${VAR}` interpolation (`[inv:...]` single-level-only
 * constraint — no recursive expansion of the substituted value). Non-string
 * values pass through unchanged. Unresolved `${VAR}` references are kept as
 * the literal `${VAR}` text.
 */
export function interpolateValue(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(INTERPOLATION_RE, (match, varName: string) => {
    const resolved = env[varName];
    return resolved !== undefined ? resolved : match;
  });
}

/** Applies `interpolateValue` to every value in a flat dot-path record. */
export function interpolateConfig(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    result[key] = interpolateValue(raw[key], env);
  }
  return result;
}

// ============================================================================
// Step 10 — unflatten to nested config
// ============================================================================

/**
 * `{"db.path": "/tmp/db", "server.port": "3000"}` →
 * `{db: {path: "/tmp/db"}, server: {port: "3000"}}`.
 */
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

// ============================================================================
// Step 11 — type-coerce values
// ============================================================================

/**
 * Coerces a single (string-or-already-typed) value according to a field's
 * declared `type`. Invalid coercions (e.g. `"abc"` as `"integer"`) return the
 * original value unchanged rather than throwing — the caller (`validation.ts`
 * via the generated `fieldSchema`) is responsible for surfacing that as a
 * validation error.
 */
export function coerceValue(value: unknown, type: ConfigFieldDefinition['type']): unknown {
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

/** Applies `coerceValue` to every flat field, using each field's declared `type`. */
export function coerceConfig(
  raw: Record<string, unknown>,
  fields: Record<string, ConfigFieldDefinition>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const field = fields[key];
    result[key] = field ? coerceValue(raw[key], field.type) : raw[key];
  }
  return result;
}
