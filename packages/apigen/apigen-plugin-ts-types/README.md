# @adhd/apigen-plugin-ts-types

Generate-only apigen output target: emit one TypeScript type-declaration file
per exported function per package (`<pkgId>/<fnName>.ts`), derived from the
function's JSON-Schema IR.

```bash
apigen generate --source ./api.ts --type ts-types --out-dir ./client
```

Named types are package-qualified (`dispatch-cli` + `validate` →
`DispatchCliValidateInput` / `DispatchCliValidateOutput`), so output from
several packages imports collision-free in one consumer. The emitter is
hand-rolled and dependency-free at runtime (only `@adhd/apigen-core-client`,
`@adhd/apigen-engine-naming`, `node:path`). Discriminated unions (`oneOf` +
`discriminator`, the `_batch` shape) emit a named union with per-branch
interfaces retaining the discriminant. Round-1 scope: primitives, objects with
`required`/optional members, arrays, literal enums, `const`, `$ref`/definitions;
unsupported constructs (`allOf`/`anyOf`, untagged `oneOf`, `patternProperties`,
`additionalProperties` schemas) fail with a clear error — never a degraded
`any`/`unknown` in the union path. See `docs/apigen/SPEC.md` §6.1.

## Building

Run `nx build apigen-plugin-ts-types` to build the library.

## Running unit tests

Run `nx test apigen-plugin-ts-types` to execute the unit tests via
[Vitest](https://vitest.dev/) (includes the esbuild compile check + negative
control on the emitted output).
