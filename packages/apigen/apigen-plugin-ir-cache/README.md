# @adhd/apigen-plugin-ir-cache

Extract-stage IR cache plugin (FEAT-002): caches the derived IR (`Operation[]`)
of one `ExtractCall` under a **content/version-addressed key** — sha256 of the
source file **and every transitively-imported local file**, plus the extractor
version and the cache-entry format version — so repeat extraction of unchanged
source is answered from disk instead of re-running the extractor (~3.4s of the
backlog CLI's cold-start cost, BUG-019).

Never mtime-keyed: unlike the in-process `ExtractionSession` cache, entries
survive git clones, CI checkouts, and cross-machine sharing.

## Usage

Wire it as the middleware of an extract-stage invoker
(`createExtractInvoker`, `@adhd/apigen-core-client`):

```ts
import { createExtractInvoker } from '@adhd/apigen-core-client';
import { createIrCacheLayer, createLocalFsBackend } from '@adhd/apigen-plugin-ir-cache';

const extractInvoke = createExtractInvoker(
  [createIrCacheLayer(createLocalFsBackend(cacheDir), { extractorVersion })],
  (call) => extract({ sourceFile: call.source, namespace: call.namespace })
);

const operations = await extractInvoke({
  source: '/path/to/client.d.ts',
  host: 'ts',
  namespace: 'backlog',
});
```

- **HIT** — the terminal extractor is never invoked.
- **MISS** — the extractor runs; the result is written through fire-and-forget
  (a slow or failing backend can never add latency to a MISS or fail a run).

## Backends

- `createLocalFsBackend(dir)` — content-addressed directory (`<dir>/<key>.json`).
  Ships in this slice.
- **Shared/remote backend (not built yet):** `IrCacheBackend` (`get`/`put` by
  key) is the seam; an HTTP content-addressed store is a same-shape
  implementation swap. Note the inherited trust model — a shared cache accepts
  entries written by other machines/CI (the same model Nx's own remote cache
  accepts), so a shared backend should only be pointed at writers you trust.

## Cache-key guarantees and known gaps

- Key covers: entry file content, all transitive local (non-`node_modules`)
  imports, `extractorVersion`, `formatVersion`, `host`, `namespace`.
- `extractorVersion` is what busts the cache when the extractor's output
  changes for the same input — including a future DEBT-003 fix (Path 2
  morph-walk correctness), which must bump it.
- **Known gap (v1):** a dependency (`node_modules`) version bump that changes a
  named type's shape without touching any locally-tracked file is a false HIT.
  Accepted for v1; `extractorVersion` covers extractor-side changes only.
- `versionHint` on `ExtractCall` is deliberately ignored — a shared cache must
  never key on an unverified caller-supplied identity.

## Building / testing

```sh
npx nx build apigen-plugin-ir-cache
npx nx test apigen-plugin-ir-cache
```
