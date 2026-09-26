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
// back to the default middleware (`./lib/default-cache-file.ts`): the
// `APIGEN_IR_CACHE_FILE` env-var override if set, otherwise a PER-SOURCE
// file under the `@adhd/environment`-namespaced machine-global cache root
// (`~/.adhd/apigen/default/cache/ir-<hash>.json`) — never the invocation
// cwd (BUG-APIGEN-058), and never a single shared `default.ir.json` that
// distinct uses would silently overwrite. `APIGEN_IR_CACHE_EXTRACTOR_VERSION`
// overrides the extractor version the same way. `layer` (the static fallback
// field) resolves the same way per call, so a caller reading
// `irCachePlugin.capabilities.extractLayer.layer` directly (rather than
// through `createExtractInvokerFromPlugins`, which always prefers
// `createLayer` when present) still gets a working, if unconfigurable,
// middleware.

import type { Plugin, ExtractCall, ExtractMiddleware } from '@adhd/apigen-core-client';
import { createIrCacheLayer, type IrCacheOptions } from './lib/ir-cache-layer';
import { buildIrCacheArtifact } from './lib/target';
import { readDefaultExtractorVersion } from './lib/version';
import { resolveDefaultCacheFile } from './lib/default-cache-file';

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
// The shared atomic+durable JSON writer. Exported (additive) because the
// bake-at-build consumer (`entrypoint/backlog`'s `ir-artifact` CLI subcommand)
// must emit `dist/api.ir.json` with the SAME durability guarantee the IR cache
// relies on, rather than hand-rolling a second writer that could drift.
export { atomicWriteJson } from './lib/atomic-write-json';

/**
 * Lazily built default `extractLayer` middleware, memoized PER resolved
 * cache file — distinct extraction targets in one process each get their
 * own layer (and their own cache file), so they can never overwrite each
 * other's entry in the shared machine-global cache.
 */
const defaultLayers = new Map<string, ExtractMiddleware>();

function resolveDefaultLayer(call: ExtractCall): ExtractMiddleware {
  const cacheFile = resolveDefaultCacheFile(call);
  let layer = defaultLayers.get(cacheFile);
  if (!layer) {
    layer = createIrCacheLayer({
      cache: cacheFile,
      extractorVersion:
        process.env['APIGEN_IR_CACHE_EXTRACTOR_VERSION'] ?? readDefaultExtractorVersion(),
    });
    defaultLayers.set(cacheFile, layer);
  }
  return layer;
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
      layer: (call, next) => resolveDefaultLayer(call)(call, next),
      createLayer: (opts) => {
        const cache = typeof opts['cache'] === 'string' ? opts['cache'] : undefined;
        if (!cache) {
          // No `--opt cache=` given — fall back to the env-var/default
          // middleware, identical to what `layer` above already resolves.
          return (call, next) => resolveDefaultLayer(call)(call, next);
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
