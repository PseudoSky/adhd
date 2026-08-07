/**
 * migration-admin.ts — persists `migration.phase` (MIGRATION.md §4.4) to the
 * GLOBAL layer's `config.yaml`, the one cascade file every future process on
 * this machine reads regardless of repo/session (`@adhd/environment`'s own
 * layer order: code defaults -> system -> global -> project -> local -> env
 * vars). A bare `ADHD_BACKLOG_MIGRATION_PHASE` env var (`env.ts`'s existing
 * read path) only affects the ONE process it happens to be exported in — not
 * a durable, cross-agent-readable signal — so `setMigrationPhase` (client.ts)
 * writes THROUGH to this file instead of merely suggesting the env var.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Environment } from '@adhd/environment';
import type { BacklogConfig } from './env.js';
import type { MigrationPhase } from './model.js';

/**
 * Mirrors `@adhd/environment-builder`'s own internal `roots.ts` global-root
 * formula (`~/.<orgNamespace>/<project>/<namespace>/config.yaml`) using ONLY
 * the public fields the `@adhd/environment` `Environment` instance exposes
 * (`orgNamespace`/`project`/`namespace`) — `@adhd/backlog` does not depend on
 * the internal `environment-builder` package directly, so this is a
 * deliberate, narrow re-derivation, not an import of a private module.
 * `adhdRootOverride` mirrors `EnvironmentOptions.adhdRoot`'s own test-isolation
 * escape hatch (see `BuildBacklogEnvOptions`) for tests that must never touch
 * the real machine-global `~/.adhd`.
 */
export function globalConfigPath(env: Environment<BacklogConfig>, adhdRootOverride?: string): string {
  const base = adhdRootOverride ?? join(homedir(), `.${env.orgNamespace}`);
  return join(base, env.project, env.namespace, 'config.yaml');
}

/**
 * Reads the existing global `config.yaml` (if any), deep-merges in
 * `migration.phase`, and writes it back — preserving every OTHER key already
 * in the file (e.g. a previously-set `db.busyTimeoutMs` override) rather than
 * clobbering the whole file. A missing or malformed existing file is treated
 * as empty (never fatal for a write), mirroring
 * `@adhd/environment-builder`'s own `readLayerFile` tolerance for a corrupt
 * layer. Returns the absolute path written, for caller confirmation.
 */
export function writeMigrationPhase(env: Environment<BacklogConfig>, phase: MigrationPhase, adhdRootOverride?: string): string {
  const path = globalConfigPath(env, adhdRootOverride);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }
  const existingMigration =
    existing['migration'] && typeof existing['migration'] === 'object' && !Array.isArray(existing['migration'])
      ? (existing['migration'] as Record<string, unknown>)
      : {};
  const next = { ...existing, migration: { ...existingMigration, phase } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(next), 'utf8');
  return path;
}
