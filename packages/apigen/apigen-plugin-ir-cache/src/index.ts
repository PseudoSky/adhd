// @adhd/apigen-plugin-ir-cache — extract-stage IR cache plugin (FEAT-002).
//
// A `layer`-shaped plugin for the extract-stage onion: caches the derived IR
// (`Operation[]`) of one `ExtractCall` under a content/version-addressed key
// (source file + transitive local imports + extractor version — never mtime),
// so repeat extraction of unchanged source is answered from disk instead of
// re-running the extractor (~3.4s for the backlog CLI hot path, BUG-019).
//
// Wire as the extract invoker's middleware:
//
//   createExtractInvoker(
//     [createIrCacheLayer(createLocalFsBackend(cacheDir), { extractorVersion })],
//     runExtractor
//   )
//
// Local filesystem backend ships first; a remote/shared backend is a same-
// shape `IrCacheBackend` implementation swap (documented, not built).

export {
  createIrCacheLayer,
  computeCacheKey,
  CURRENT_FORMAT_VERSION,
} from './lib/ir-cache-layer';
export type {
  IrCacheBackend,
  CachedExtractEntry,
} from './lib/ir-cache-layer';
export { createLocalFsBackend } from './lib/backends/fs-backend';
