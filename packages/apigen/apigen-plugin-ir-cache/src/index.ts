// @adhd/apigen-plugin-ir-cache — extract-stage IR cache plugin (FEAT-002,
// Revision 2: docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md).
//
// A `Plugin` carrying TWO independent capabilities over the SAME
// `CachedExtractEntry` shape:
//
//   - `extractLayer` — RUNTIME CACHE mode (`--use ir-cache`). Wraps the
//     extract-stage invoker (`createExtractInvoker`/`createExtractInvokerFromPlugins`,
//     `@adhd/apigen-core-client`): caches the derived IR (`Operation[]`) of
//     one `ExtractCall` at a single, literal, pre-agreed file path
//     (`./lib/ir-cache-layer.ts`), so repeat extraction of unchanged source
//     is answered from disk (a handful of `stat()` calls on the common HIT)
//     instead of re-running the extractor (~3.4s for the backlog CLI hot
//     path, BUG-019).
//   - `target` — ARTIFACT mode (`--type ir-cache --opt cache=artifact`).
//     Produces a one-shot, build-time JSON artifact (`./lib/target.ts`) —
//     zero extraction machinery in the runtime path at all.
//
// Both modes are selected by ONE `IrCacheOptions.cache` option (R2.2): a
// file path selects RUNTIME CACHE mode, the literal string `'artifact'`
// selects ARTIFACT mode.
//
// `irCachePlugin`'s `extractLayer` capability honors `--use ir-cache --opt
// cache=<path>` via `createLayer` (`ExtractLayerCapability.createLayer`,
// `@adhd/apigen-core-client`'s `plugin.ts`): `createExtractInvokerFromPlugins`
// calls `createLayer(opts)` once per plugin at invoker-construction time with
// this invocation's flat `--opt` bag, so `opts.cache`/`opts.extractorVersion`
// — when present — select the SAME `createIrCacheLayer(opts)` factory a host
// building its own `Plugin` object (e.g. `entrypoint/backlog/src/server.ts`'s
// `backlogIrCachePlugin()`) already uses directly.
//
// `opts.cache` absent (e.g. a bare `--use ir-cache` with no `--opt`) falls
// back to the pre-existing env-var default (`APIGEN_IR_CACHE_FILE`/
// `APIGEN_IR_CACHE_EXTRACTOR_VERSION`, lazily resolved on first call and
// memoized) — unchanged behaviour for any caller not passing `--opt cache=`.
// `layer` (the static fallback field) still resolves to that same env-var
// default, so a caller reading `irCachePlugin.capabilities.extractLayer.layer`
// directly (rather than through `createExtractInvokerFromPlugins`, which
// always prefers `createLayer` when present) still gets a working, if
// unconfigurable, middleware.

import { join } from 'node:path';
import type { Plugin } from '@adhd/apigen-core-client';
import { createIrCacheLayer, type IrCacheOptions } from './lib/ir-cache-layer';
import { buildIrCacheArtifact } from './lib/target';
import { readDefaultExtractorVersion } from './lib/version';

export {
  createIrCacheLayer,
  computeCacheKey,
  CURRENT_FORMAT_VERSION,
} from './lib/ir-cache-layer';
export type {
  IrCacheBackend,
  IrCacheOptions,
  CachedExtractEntry,
  CachedExtractStaleness,
} from './lib/ir-cache-layer';
export { createLocalFsBackend } from './lib/backends/fs-backend';
export { createSingleFileBackend } from './lib/backends/single-file-backend';
export { buildIrCacheArtifact } from './lib/target';
export { readDefaultExtractorVersion } from './lib/version';

/**
 * Default RUNTIME CACHE mode cache-file path, env-overridable —
 * `APIGEN_IR_CACHE_FILE` (design doc R2-4's naming; this package does not
 * itself read `APIGEN_IR_CACHE_ENABLED` — the opt-out kill switch is a
 * caller/host concern, e.g. `entrypoint/backlog/src/server.ts` deciding
 * whether to include `irCachePlugin` in its plugin list at all, not this
 * plugin's own responsibility).
 */
function defaultCacheFilePath(): string {
  return (
    process.env['APIGEN_IR_CACHE_FILE'] ??
    join(process.cwd(), 'tmp', 'apigen', 'ir-cache', 'default.ir.json')
  );
}

let defaultLayer: ReturnType<typeof createIrCacheLayer> | undefined;

/** Lazily build (and memoize) the default `extractLayer.layer` middleware. */
function resolveDefaultLayer(): ReturnType<typeof createIrCacheLayer> {
  defaultLayer ??= createIrCacheLayer({
    cache: defaultCacheFilePath(),
    extractorVersion:
      process.env['APIGEN_IR_CACHE_EXTRACTOR_VERSION'] ?? readDefaultExtractorVersion(),
  });
  return defaultLayer;
}

/**
 * The default, ready-to-`--use` `Plugin` object. Carries BOTH capabilities:
 * `extractLayer` (RUNTIME CACHE, resolved from env vars — see module doc
 * above) and `target` (ARTIFACT mode, `opts` resolved per-invocation by the
 * CLI as normal since `TargetCapability.generate` already receives `opts` as
 * a parameter — no env-var workaround needed there).
 */
export const irCachePlugin: Plugin<IrCacheOptions> = {
  id: 'ir-cache',
  description:
    'Extract-stage IR cache: runtime write-through cache (--use ir-cache) or ' +
    'build-time artifact (--type ir-cache --opt cache=artifact)',
  language: 'ts',
  optionsSchema: {
    type: 'object',
    properties: {
      cache: { type: 'string' },
      filename: { type: 'string' },
      extractorVersion: { type: 'string' },
    },
    required: ['cache'],
    additionalProperties: false,
  },
  capabilities: {
    extractLayer: {
      layer: (call, next) => resolveDefaultLayer()(call, next),
      createLayer: (opts) => {
        const cache = typeof opts['cache'] === 'string' ? opts['cache'] : undefined;
        if (!cache) {
          // No `--opt cache=` given — fall back to the env-var/default
          // middleware, identical to what `layer` above already resolves.
          return (call, next) => resolveDefaultLayer()(call, next);
        }
        const extractorVersion =
          typeof opts['extractorVersion'] === 'string'
            ? opts['extractorVersion']
            : readDefaultExtractorVersion();
        return createIrCacheLayer({ cache, extractorVersion });
      },
    },
    target: {
      name: 'ir-cache',
      generate: buildIrCacheArtifact,
    },
  },
};
