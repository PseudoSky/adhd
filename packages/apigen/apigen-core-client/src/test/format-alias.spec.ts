/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `format-alias.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer constructs real ts-morph Projects over in-memory source (measured ~21s / 8 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `format-alias.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: format-alias", () => {
  it.todo("mocked: plain `type X = string` with no JSDoc -> undefined");
  it.todo("mocked: `/** @format decimal */ type X = string` -> \"decimal\"");
  it.todo("mocked: a generic reference `Array<X>` -> undefined (generics out of scope)");
  it.todo("mocked: a qualified name (`NS.X`) -> undefined (qualified names out of scope)");
  it.todo("mocked: a type alias to an object type with @format -> undefined (scalar guard)");
  it.todo("mocked: plain keyword type `string` (not a TypeReference at all) -> undefined");
  it.todo("mocked: undefined typeNode input -> undefined");
  it.todo("mocked: a different tag name (@example) is not mistaken for @format");
});
