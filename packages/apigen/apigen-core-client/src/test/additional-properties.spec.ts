/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `additional-properties.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer walks real ts-morph types via the Path-2 morph-walk (measured ~13s / 4 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `additional-properties.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: additional-properties", () => {
  it.todo("mocked: a named-interface param with required + optional fields (Path 2) gets additionalProperties:false");
  it.todo("mocked: a Path-2 object with zero required fields still gets additionalProperties:false");
  it.todo("mocked: a CreateItemInput-shaped real-world Path-2 object gets additionalProperties:false");
  it.todo("mocked: a Path-2 object with BOTH named properties AND a string index signature is NOT closed — additionalProperties becomes the index value schema, not false");
});
