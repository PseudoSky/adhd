/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `ir-cache-plugin-registration.e2e.ts`.
 *
 * Resource lane: proc — it spawns the built `dist/index.js` via `execFileSync` (real CLI subprocesses).
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `ir-cache-plugin-registration.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: ir-cache-plugin-registration', () => {
  it.todo("mocked: `apigen list-types` (--type registry) lists ir-cache");
  it.todo("mocked: `--type ir-cache --opt cache=artifact` (ARTIFACT mode / target capability) produces a real CachedExtractEntry artifact — not \"Unknown --type: ir-cache\"");
  it.todo("mocked: `--type ir-cache` without `--opt cache=artifact` fails with the plugin\\");
  it.todo("mocked: `--use ir-cache` (RUNTIME CACHE mode / extractLayer capability) writes a real cache file with a staleness snapshot — not \"Unknown --use ir-cache\"");
  it.todo("mocked: `--use ir-cache --opt cache=<path>` reuses the cache on a SECOND real CLI run — no re-extraction (mtime unchanged)");
  it.todo("mocked: ARTIFACT mode -> RUNTIME CACHE mode interop: a real generated artifact is consumed by a real --use run, revalidates once, then fast-HITs");
});
