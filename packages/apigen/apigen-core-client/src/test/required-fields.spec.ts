/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `required-fields.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer walks real ts-morph types via the Path-2 morph-walk (measured ~10s / 5 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `required-fields.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: required-fields", () => {
  it.todo("mocked: a named interface param with a mix of required + optional fields produces a `required` array containing exactly the required field names");
  it.todo("mocked: a type with zero required fields omits `required` entirely (matches ts-json-schema-generator convention of never emitting `required: []`)");
  it.todo("mocked: a CreateItemInput-shaped real-world type (entrypoint/backlog model.ts) carries all its required string fields into `required` and excludes every optional field");
  it.todo("mocked: a named interface param schema (Path 2) carries additionalProperties:false");
  it.todo("mocked: Ajv actually rejects an unrecognized nested key using the real generated schema");
});
