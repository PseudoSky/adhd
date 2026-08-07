// target.ts — ARTIFACT mode (FEAT-002 Revision 2, design doc R2.4).
//
// A one-shot BUILD-TIME artifact: a JSON `CachedExtractEntry` file produced
// once, at `apigen generate --type ir-cache --opt cache=artifact` time, that
// ships alongside a consumer's own build with ZERO extraction machinery in
// the runtime path at all — not even a cache lookup. This is the `target`
// capability half of the plugin; `./ir-cache-layer.ts` is the `extractLayer`
// (RUNTIME CACHE) half.
//
// WHY a `target` capability and not a build-hook (rollup writeBundle/etc.):
// rollup resolves static imports BEFORE `writeBundle`-style hooks fire, so a
// chunk containing `import data from './client.ir.json'` would be
// unresolvable the first time (or after the artifact is deleted) if
// generation happened inside the same build pass that imports it — a
// chicken-and-egg failure. Reusing the existing `TargetCapability` shape and
// the existing `apigen generate --type <plugin-id> --out-dir <path>` CLI
// invocation sidesteps this: artifact production is a SEPARATE command, a
// SEPARATE process, run strictly BEFORE the consumer's own build — never a
// hook inside it. See the design doc's R2.4 for the full ordering-constraint
// rationale and the recommended Nx `generate-ir-cache` → `build` target
// wiring (`dependsOn`).
//
// The emitted entry has NO `staleness` field — an artifact is never
// read-time-staleness-checked (that's the RUNTIME CACHE mode's job); its
// freshness comes from WHEN the generating command was run, which is the
// consumer's own build-ordering responsibility, not this plugin's.

import type { Descriptor, File } from '@adhd/apigen-core-client';
import { CURRENT_FORMAT_VERSION } from './ir-cache-layer';
import type { CachedExtractEntry, IrCacheOptions } from './ir-cache-layer';
import { readDefaultExtractorVersion } from './version';

/**
 * The `target` capability's `generate()` (design doc R2.4). Builds ONE
 * `CachedExtractEntry` from `descriptor.operations` (no `staleness` field)
 * and emits it as a single file.
 *
 * @throws if `opts.cache !== 'artifact'` — that's the RUNTIME CACHE mode
 *   signal (`./ir-cache-layer.ts`'s `createIrCacheLayer`), not this target;
 *   a caller mistake this function catches rather than silently emitting a
 *   wrongly-named/wrongly-shaped file.
 */
export function buildIrCacheArtifact(
  descriptor: Descriptor,
  opts: IrCacheOptions
): File[] {
  if (opts.cache !== 'artifact') {
    throw new Error(
      `apigen-plugin-ir-cache: --type ir-cache requires --opt cache=artifact ` +
        `(got "${opts.cache}"). RUNTIME CACHE mode (a file path) is a --use ` +
        `layer, not a --type target — see docs/apigen/design-notes/` +
        `extract-stage-onion-and-ir-cache.md Revision 2.`
    );
  }

  const entry: CachedExtractEntry = {
    formatVersion: CURRENT_FORMAT_VERSION,
    operations: descriptor.operations,
    extractorVersion: opts.extractorVersion ?? readDefaultExtractorVersion(),
    createdAt: new Date().toISOString(),
    // No `staleness` — see module doc above.
  };

  return [
    { path: opts.filename ?? 'ir-cache.json', content: JSON.stringify(entry, null, 2) },
  ];
}
