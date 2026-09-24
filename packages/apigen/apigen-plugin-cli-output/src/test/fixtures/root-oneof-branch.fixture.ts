// Shared, importable fixture for BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001,
// used by BOTH lanes the suite is split across:
//   - root-oneof-branch.spec.ts  (default lane — resolveRootUnion + generate() unit tests)
//   - root-oneof-branch.e2e.ts   (e2e lane  — the real spawned `node` subprocess proof)
//
// It lives in a non-test `.fixture.ts` module (never a `*.spec.ts`/`*.e2e.ts`)
// and in `src/test/fixtures/` (already excluded from `tsconfig.lib.json`'s
// `src/test/**`) so neither lane imports the other — importing a test file
// would re-register that file's suites inside the importing run.
//
// Fixture provenance (BUG-APIGEN-CLI-002 update): this suite's fixture used to
// be sourced VERBATIM from `@adhd/apigen-core-client`'s real
// `buildBatchMountedOperations` (`_batch/<kind>`'s actual production schema)
// specifically because that was, at the time, the one real root-level
// `oneOf`+`discriminator` domain schema shipping anywhere in this repo.
// BUG-APIGEN-CLI-002 changed `batch.ts`'s `branchInputSchema` to nest every
// control-plane field (INCLUDING the `operation` discriminator) under one
// top-level `input` object, matching the single-JSON-blob convention every
// other apigen-mounted operation uses — but a discriminator's `propertyName`
// must, by the OpenAPI/JSON-Schema `discriminator` contract, name a property
// that sits DIRECTLY on the oneOf'd object; once `operation` moved a level
// deeper it can no longer serve that role, so `buildBatchKindSchema` no
// longer emits a `discriminator` at all (see `batch.ts`'s own doc comment on
// `branchInputSchema`). `_batch/<kind>` is therefore no longer a real
// root-oneof+discriminator schema to source this fixture from.
//
// `resolveRootUnion`/`generate()`'s root-union codegen capability is still
// real, shipped code — it exists for ANY future operation whose domain
// schema is itself a discriminated `oneOf` (independent of batch) — so this
// suite now hand-constructs an equivalent fixture in that exact shape
// (mirroring what `_batch/<kind>` used to look like pre-fix) rather than
// asserting nothing is left to test.

// Hand-built root-level `oneOf`+`discriminator` domain schema. Shape mirrors
// `_batch/<kind>`'s PRE-fix output byte-for-byte: two branches, discriminated
// by a top-level `operation` literal, each carrying a flat `items` (+ the
// other batch control-plane fields) directly on the branch.
export function realBatchDomainSchema(): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: 'object',
        required: ['operation', 'items'],
        properties: {
          operation: { type: 'string', enum: ['createItem'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
          concurrency: { type: 'number' },
          mode: { type: 'string', enum: ['parallel', 'serial', 'chained'] },
          onItemError: { type: 'string', enum: ['continue', 'abort'] },
          itemTimeoutMs: { type: 'number' },
        },
        additionalProperties: true,
      },
      {
        type: 'object',
        required: ['operation', 'items'],
        properties: {
          operation: { type: 'string', enum: ['sendTask'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { taskId: { type: 'string' } },
              required: ['taskId'],
            },
          },
          concurrency: { type: 'number' },
          mode: { type: 'string', enum: ['parallel', 'serial', 'chained'] },
          onItemError: { type: 'string', enum: ['continue', 'abort'] },
          itemTimeoutMs: { type: 'number' },
        },
        additionalProperties: true,
      },
    ],
    discriminator: {
      propertyName: 'operation',
      mapping: { createItem: '#/oneOf/0', sendTask: '#/oneOf/1' },
    },
  };
}
