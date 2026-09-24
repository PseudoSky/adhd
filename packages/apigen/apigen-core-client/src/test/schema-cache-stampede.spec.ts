/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `schema-cache-stampede.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer fires N concurrent buildSchema() calls over real TypeScript (measured ~26s / 4 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `schema-cache-stampede.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: schema-cache-stampede", () => {
  it.todo("mocked: N concurrent buildSchema() calls for the identical (sourceFile, tsconfig, typeText) key trigger the expensive Path-2 resolution exactly ONCE");
  it.todo("mocked: a SEQUENTIAL second call after the first resolves is served from cache too (not just concurrent joins)");
  it.todo("mocked: a rejected computation is NOT cached permanently — a later call for the same key gets a fresh attempt");
  it.todo("mocked: BUG-APIGEN-CORE-003 deadlock guard: a self-referential type resolves without hanging (not just without OOMing)");
});
