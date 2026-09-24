/**
 * embedding-config.ts — per-process liveness for the `embedding.*` config family.
 *
 * ## The defect this closes
 *
 * `@adhd/environment`'s `Environment` resolves its ENTIRE cascade once, in
 * memory, at construction (`packages/environment/ARCHITECTURE.md` §2.1;
 * `environment.ts:194-203`): every field is a resolved-once snapshot unless it
 * is declared `secret` or `at:'runtime'`. `embedding.enabled`/`.provider`/
 * `.model` (`../env.ts`) are none of those (`at:'runtime'` re-reads
 * `process.env`, which an operator cannot mutate on a running process), so a
 * long-lived `serve` that boots with `embedding.enabled:false` keeps that
 * value forever — even after the operator edits `config.yaml` to `true`. The
 * member-less derive in `write/bootstrap.ts` then never produces the
 * `embedding` handle, and `write/embedding-observer.ts` returns without an
 * attempt on every subsequent write.
 *
 * ## The mechanism
 *
 * This module does NOT touch `@adhd/environment` or its resolve-once contract.
 * It is a CONSUMER-side re-resolution, scoped to the `embedding.*` family only:
 *
 *  - a cheap `stat()` fingerprint over the config LAYER FILES (the same files
 *    the environment cascade reads — enumerated from the builder's own
 *    `resolveEnvironmentContext`, never hand-derived) gates a full re-resolve;
 *  - when a layer file's `mtimeMs:size` stamp changes, the caller's `rebuild()`
 *    (a plain `buildBacklogEnv(<same opts>)`) constructs a FRESH `Environment`,
 *    and only its `embedding.*` slice is adopted;
 *  - `db.*`/`logging.level` are deliberately NOT reloadable: swapping the whole
 *    `Environment` mid-process would silently move an already-open store. They
 *    stay resolve-once and restart-required, and this module never returns them.
 *
 * `refresh()` is a plain synchronous function. `Environment` construction is
 * synchronous, and JS is single-threaded, so there is no in-flight promise to
 * share between concurrent semantic verbs — a second caller in the same tick
 * simply sees the already-updated fingerprint and skips the rebuild. That is
 * the single-flight guarantee the seam relies on.
 *
 * The holder keeps a `divergent()` signal distinct from `refresh()`: on-disk
 * says enabled while the process is still effectively disabled. It is
 * reachable before the next semantic verb adopts (e.g. an observability read
 * after an operator edits the file), and it is what `write/bootstrap.ts` turns
 * into a specific, once-per-process WARN carrying both content hashes.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '@adhd/environment';
import type { Scope } from '@adhd/environment-base-spec';
import {
  CONFIG_FILENAME,
  LOCAL_CONFIG_FILENAME,
} from '@adhd/environment-base-spec';
import { resolveEnvironmentContext } from '@adhd/environment-builder';
import { backlogEnvironmentSpec, resolveBacklogScope } from '../env.js';
import type { BacklogConfig } from '../env.js';

/** The reloadable slice — exactly `BacklogConfig['embedding']`, by value. */
export interface EmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
}

/** A change detector over the config LAYERS feeding `embedding.*`. */
export interface EmbeddingFingerprint {
  /**
   * The resolution cascade's own content hash
   * (`Environment.version.configHash`) as of the last observation. Covers
   * EVERY field, so it is compared only to decide whether the file content
   * actually changed — never to decide what to adopt.
   */
  readonly configHash: string;
  /** Cheap pre-gate: path -> `${mtimeMs}:${size}` (or `absent`) per layer file. */
  readonly files: ReadonlyArray<{ path: string; stamp: string }>;
}

export interface EmbeddingLiveConfig {
  /** Effective NOW — the last ADOPTED on-disk value, not the startup snapshot. */
  current(): EmbeddingConfig;
  /** Last value observed on disk (may equal `current()` after a refresh). */
  configured(): EmbeddingConfig;
  /** True when on-disk says enabled but the effective value is still disabled. */
  divergent(): boolean;
  /** Cheap stat pre-gate, then (on change) rebuild + adopt. */
  refresh(): { changed: boolean; from: EmbeddingConfig; to: EmbeddingConfig };
  fingerprint(): EmbeddingFingerprint;
}

/** Options mirroring the subset of `BuildBacklogEnvOptions` that selects the config layers. */
export interface BacklogConfigLayerOptions {
  scope?: Scope;
  adhdRoot?: string;
  cwd?: string;
  namespace?: string;
}

/**
 * The resolved config LAYER FILE paths the `backlog` environment cascade reads
 * — system/global `config.yaml` plus, when a project root resolves,
 * `config.yaml` + `config.local.yaml` there.
 *
 * Enumerated from `@adhd/environment-builder`'s own `resolveEnvironmentContext`
 * (the SAME root resolution `Environment`'s constructor runs) and the
 * base-spec's `CONFIG_FILENAME`/`LOCAL_CONFIG_FILENAME` constants — never a
 * hand-built `~/.adhd/...` path that could drift from the builder's scheme.
 * Duplicates are collapsed: an explicit `adhdRoot` overrides BOTH the `global`
 * and `system` root bases in `resolveRoots`, so those two layers resolve to the
 * same file under test isolation and must be fingerprinted once.
 */
export function backlogConfigLayerFiles(
  opts: BacklogConfigLayerOptions = {}
): string[] {
  const ctx = resolveEnvironmentContext('backlog', backlogEnvironmentSpec, {
    namespace: opts.namespace ?? 'production',
    scope: resolveBacklogScope(opts.scope),
    ...(opts.adhdRoot !== undefined ? { adhdRoot: opts.adhdRoot } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const files = [
    join(ctx.roots.system, CONFIG_FILENAME),
    join(ctx.roots.global, CONFIG_FILENAME),
  ];
  if (ctx.roots.project) {
    files.push(join(ctx.roots.project, CONFIG_FILENAME));
    files.push(join(ctx.roots.project, LOCAL_CONFIG_FILENAME));
  }
  return [...new Set(files)];
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const pick = (embedding: BacklogConfig['embedding']): EmbeddingConfig => ({
  enabled: embedding.enabled === true,
  provider: embedding.provider,
  model: embedding.model,
});

const sameEmbedding = (a: EmbeddingConfig, b: EmbeddingConfig): boolean =>
  a.enabled === b.enabled && a.provider === b.provider && a.model === b.model;

/**
 * Builds the live holder for one long-lived process.
 *
 * @param opts.baseline the `ctx.env` `startBacklogServer` already built — its
 *   `config.embedding` is the effective value until a refresh adopts a change,
 *   and its `version.configHash` is the "startup hash" the divergence WARN
 *   reports.
 * @param opts.rebuild `() => buildBacklogEnv(<the SAME opts>)` — a fresh
 *   `Environment`, never a mutation of `baseline`.
 * @param opts.layerFiles the resolved config layer paths (see
 *   {@link backlogConfigLayerFiles}); called on every observation, cheap.
 * @param opts.log where an adoption (`'info'`) or a re-read failure (`'warn'`)
 *   is reported. The write layer's only sink is `console.error`.
 */
export function createEmbeddingLiveConfig(opts: {
  baseline: Environment<BacklogConfig>;
  rebuild: () => Environment<BacklogConfig>;
  layerFiles: () => readonly string[];
  log: (level: 'info' | 'warn', message: string) => void;
}): EmbeddingLiveConfig {
  const stamps = (): ReadonlyArray<{ path: string; stamp: string }> =>
    opts.layerFiles().map((path) => {
      try {
        const s = statSync(path);
        return { path, stamp: `${s.mtimeMs}:${s.size}` };
      } catch {
        // Absent/unreadable is a stable, meaningful state: a file that
        // appears later changes the stamp and trips a rebuild.
        return { path, stamp: 'absent' };
      }
    });

  const sameStamps = (
    a: ReadonlyArray<{ path: string; stamp: string }>,
    b: ReadonlyArray<{ path: string; stamp: string }>
  ): boolean =>
    a.length === b.length &&
    a.every((x, i) => x.path === b[i].path && x.stamp === b[i].stamp);

  let effective = pick(opts.baseline.config.embedding);
  let observed = effective;
  let fingerprint: EmbeddingFingerprint = {
    configHash: opts.baseline.version.configHash,
    files: stamps(),
  };

  /**
   * The stat pre-gate + rebuild. Returns whether a rebuild ran. A rebuild
   * failure (a malformed layer file, a schema violation) is logged and the
   * previous state — INCLUDING the old fingerprint — is kept, so the next
   * verb retries once the operator fixes the file, and a broken file can never
   * take a semantic verb down.
   */
  const observe = (): boolean => {
    const files = stamps();
    if (sameStamps(files, fingerprint.files)) return false;
    let next: Environment<BacklogConfig>;
    try {
      next = opts.rebuild();
    } catch (err) {
      opts.log(
        'warn',
        `backlog: could not re-read the embedding config layers (${errText(
          err
        )}) — continuing with the last known effective embedding settings`
      );
      return false;
    }
    fingerprint = { configHash: next.version.configHash, files };
    observed = pick(next.config.embedding);
    return true;
  };

  return {
    current: () => effective,
    configured: () => {
      observe();
      return observed;
    },
    divergent: () => {
      observe();
      return observed.enabled && !effective.enabled;
    },
    refresh: () => {
      const from = effective;
      observe();
      if (sameEmbedding(observed, effective)) {
        return { changed: false, from, to: effective };
      }
      effective = observed;
      opts.log(
        'info',
        `backlog: embedding config changed on disk (enabled ${from.enabled}→${effective.enabled}, ` +
          `provider ${effective.provider}, model ${effective.model}); adopting without restart`
      );
      return { changed: true, from, to: effective };
    },
    fingerprint: () => fingerprint,
  };
}
