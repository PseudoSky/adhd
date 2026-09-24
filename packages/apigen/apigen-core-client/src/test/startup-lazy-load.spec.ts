/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `startup-lazy-load.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns a fresh `node` child-process probe against a scratch CJS transpile (measured ~1.2s / 3 cases).
 * This file spawns nothing and imports no built artifact; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `startup-lazy-load.e2e.ts`); they are the contract a mocked version must
 * satisfy without spawning a subprocess.
 *
 * Resource lane: proc.
 */
import { describe, it } from 'vitest';

describe("mocked: startup-lazy-load", () => {
  it.todo("mocked: imports clean, runs the non-lazy surface armed, then resolves ts-morph on first lazy use");
  it.todo("mocked: teeth: an eager static import of ts-morph trips the guard at import");
  it.todo("mocked: teeth: an eager static import of ts-json-schema-generator trips the guard at import");
});
