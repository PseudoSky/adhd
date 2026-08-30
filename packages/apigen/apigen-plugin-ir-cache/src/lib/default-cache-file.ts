// default-cache-file.ts — default RUNTIME CACHE mode cache-file resolution
// (BUG-APIGEN-058).
//
// Replaces the former `join(process.cwd(), 'tmp', 'apigen', 'ir-cache',
// 'default.ir.json')` default, which had TWO defects:
//
//   1. It was `process.cwd()`-relative — a fresh, permanently-cold cache
//      file (and a fresh `tmp/apigen/` tree) appeared in EVERY directory the
//      plugin was used from, exactly the defect backlog's own wiring already
//      fixed for itself in BUG-CACHE-CWD-001.
//   2. It was a single shared `default.ir.json` name — but the RUNTIME CACHE
//      mode file holds exactly ONE extraction result, so any two distinct
//      uses (different projects, different source files) would silently
//      overwrite each other's entry and every consumer would MISS forever.
//
// New default — resolution order (highest precedence first):
//
//   1. `APIGEN_IR_CACHE_FILE` — the caller's explicit full-path override
//      (unchanged; wins outright, tests and hosts point this at a file of
//      their choosing).
//   2. The `@adhd/environment`-namespaced machine-global cache root for
//      project `apigen` — `new Environment('apigen', spec, { scope:
//      'global' })` → `${HOME}/.adhd/apigen/default/cache` — joined with a
//      PER-SOURCE file name derived from the extraction identity (host |
//      namespace | absolute source path). Absolute, `process.cwd()`-
//      independent, and identical for the same extraction target everywhere
//      on this machine: a repeated extraction of the same source HITs its
//      own stable file, and two different extraction targets never share a
//      file, so they can never overwrite each other.
//
// `ADHD_ROOT` (the env-var override `entrypoint/backlog`'s CLI already
// honors for the same purpose) or an explicit `opts.adhdRoot` (test
// isolation, mirroring `entrypoint/backlog/src/env.ts`'s
// `resolveIrCacheFile({ adhdRoot })`) redirects the root.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Environment } from '@adhd/environment';
import type { ExtractCall } from '@adhd/apigen-core-client';

/**
 * The `@adhd/environment` spec for the plugin's own global cache root. Only
 * a `cache` dir is declared (kind `cache` ⇒ shared): the default path lives
 * under the standard `${HOME}/.adhd/<org>/<project>/<namespace>/cache`
 * namespacing, the same machine-global scoping every other adhd tool gets.
 * `config` is an empty record — the spec type requires it; the plugin has no
 * config fields.
 */
const apigenIrCacheEnvironmentSpec = {
  dirs: { cache: { kind: 'cache' as const } },
  config: {},
};

/**
 * The per-extraction-target cache file name: a short sha256 of the
 * extraction identity (`host | namespace | source`), stable across
 * invocations and machines for the same target, unique across distinct
 * targets. This is what keeps distinct uses of the default path from
 * overwriting each other — each source/host/namespace combination owns one
 * single-entry cache file forever.
 */
export function defaultCacheFileName(call: ExtractCall): string {
  const identity = `${call.host ?? 'host'}|${call.namespace ?? 'ns'}|${call.source}`;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return `ir-${digest}.json`;
}

/**
 * The machine-global, environment-namespaced cache DIRECTORY for the default
 * path. `scope` is forced to `'global'` (never auto-detected, never the
 * invocation cwd): the plugin's cache caches extraction of the caller's
 * source, not per-repo data, so it must stay at one stable machine-wide
 * location no matter where it is invoked from — the same guarantee
 * `entrypoint/backlog/src/env.ts`'s `resolveIrCacheFile` makes for its own
 * cache. `opts.adhdRoot` redirects the root (test isolation / sandbox).
 */
export function resolveDefaultCacheDir(opts: { adhdRoot?: string } = {}): string {
  const env = new Environment<Record<string, unknown>>('apigen', apigenIrCacheEnvironmentSpec, {
    scope: 'global',
    ...(opts.adhdRoot !== undefined ? { adhdRoot: opts.adhdRoot } : {}),
  });
  return env.paths['cache'] as string;
}

/**
 * The complete default RUNTIME CACHE mode cache-file path for one
 * `ExtractCall`. `APIGEN_IR_CACHE_FILE` (when set) wins outright; otherwise
 * the per-source file name inside the machine-global, environment-namespaced
 * cache root (honoring `ADHD_ROOT`, then `opts.adhdRoot`).
 */
export function resolveDefaultCacheFile(
  call: ExtractCall,
  opts: { adhdRoot?: string } = {}
): string {
  const fromEnv = process.env['APIGEN_IR_CACHE_FILE'];
  if (fromEnv) return fromEnv;
  const adhdRoot = opts.adhdRoot ?? process.env['ADHD_ROOT'];
  const dir = resolveDefaultCacheDir(adhdRoot !== undefined ? { adhdRoot } : {});
  return join(dir, defaultCacheFileName(call));
}
