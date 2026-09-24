/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `generate.e2e.ts`.
 *
 * Resource lane: cpu — it runs real ts-morph extraction and writes generated artifacts (~27s of pure CPU).
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `generate.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: generate', () => {
  it.todo("mocked: writes JSON schema files to the output directory");
  it.todo("mocked: resolves --export default to ExportMode { type: default }");
  it.todo("mocked: resolves --export myApi to ExportMode { type: named-object, name: myApi }");
  it.todo("mocked: resolves omitted --export to ExportMode { type: named }");
  it.todo("mocked: passes --opt transport=sse into plugin options");
  it.todo("mocked: throws when --type specifies an unknown plugin");
  it.todo("mocked: --type help text lists every registered plugin id, and changes when the registry changes");
  it.todo("mocked: a --use plugin declaring extractLayer actually intercepts extraction for the real `generate` command (BUG-APIGEN-CLI-GENERATE-USE-UNRESOLVED-001)");
  it.todo("mocked: discovers pkg-a and pkg-b by tag and produces output for both");
  it.todo("mocked: a --use plugin declaring extractLayer actually intercepts extraction for the real `generate-registry` command (BUG-APIGEN-CLI-GENERATE-USE-UNRESOLVED-001)");
  it.todo("mocked: excludes packages matching --exclude-tag");
  it.todo("mocked: returns packages sorted alphabetically");
  it.todo("mocked: returns empty array when no packages match includeTags");
  it.todo("mocked: returns empty set for a plain JSON object with no format");
  it.todo("mocked: collects a top-level format");
  it.todo("mocked: collects formats nested in properties");
  it.todo("mocked: collects formats nested arbitrarily deep");
  it.todo("mocked: handles arrays inside schemas without throwing");
  it.todo("mocked: handles cyclic objects without infinite loop");
  it.todo("mocked: returns empty set for primitives");
  it.todo("mocked: returns empty record when no rich types are used");
  it.todo("mocked: returns decimal.js when a parameter has format:decimal");
  it.todo("mocked: returns decimal.js when only the output has format:decimal");
  it.todo("mocked: does NOT include decimal.js for date-time, int64, byte (stdlib/branded)");
  it.todo("mocked: unions deps from multiple operations");
  it.todo("mocked: maps decimal format to decimal.js ^10");
  it.todo("mocked: does not carry a dep for stdlib formats");
  it.todo("mocked: writes decimal.js into package.json when schemas carry format:decimal");
  it.todo("mocked: [teeth] patchPackageJsonDeps is a no-op when dep map is empty — proves collection step is load-bearing");
  it.todo("mocked: [negative-control] does NOT declare decimal.js for a surface with no Decimal types");
  it.todo("mocked: v2 generate pipeline: generated package.json declares decimal.js for a default-imported Decimal source");
  it.todo("mocked: full CLI generate: package.json in output declares decimal.js for a default-imported Decimal source");
  it.todo("mocked: [negative-control] generated package.json does NOT declare decimal.js when patching is bypassed");
});
