# apigen logical-types — cross-language serialization

One registry-driven, codegen-first mechanism that round-trips non-JSON-native types and custom classes across host languages via native hooks.

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **A Date param/return round-trips through the built bin over MCP/HTTP (behavioral)** — A Date param/return round-trips through the built bin over MCP/HTTP.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node dist/packages/apigen/cli/index.js run --source <date-fixture>.ts --type mcp`
  - observable: `callTool returns at as RFC3339 UTC; an input Date arrives as a real Date (d.getTime works)`
  - negative-control: `in the date-time codec return at as an empty object instead of RFC3339 UTC so the built bin dist/packages/apigen/cli/index.js callTool stops yielding RFC3339 -> red`
  - delivered-by: `lt-scalars, lt-extract-scalars, lt-generator-emit, lt-dispatch-integration, lt-package, lt-contracts, lt-registry, lt-runmode-closures`

- `[dod.2]` **An int64 beyond MAX_SAFE_INTEGER round-trips without precision loss (behavioral)** — An int64 beyond MAX_SAFE_INTEGER round-trips without precision loss.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 2`
  - observable: `value survives as decimal string and decodes to an exact BigInt`
  - negative-control: `decode int64 as a JS number so probe_logical.mjs --dod 2 no longer recovers an exact BigInt from the decimal string -> red`
  - delivered-by: `lt-scalars, lt-dispatch-integration`

- `[dod.3]` **A user class round-trips TS->wire->Python->wire->TS as a real instance on both hosts (behavioral)** — A user class round-trips TS->wire->Python->wire->TS as a real instance on both hosts.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `python3 docs/plan/apigen-logical-types/scripts/audit_lt-conformance-crosshost.py`
  - observable: `instanceof holds both hosts; fields deep-equal the seed`
  - negative-control: `remove the constructor binding so the cross-host decoded value has instanceof false (a prototype-stripped object, not a real instance) -> red`
  - delivered-by: `lt-nominal-codec, lt-extract-nominal, lt-host-ts, lt-host-python`

- `[dod.4]` **A Dog|Cat position dispatches to the correct variant by wire discriminator (behavioral)** — A Dog|Cat position dispatches to the correct variant by wire discriminator.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 4`
  - observable: `decoded value is the correct variant type`
  - negative-control: `drop the wire discriminator so the decoded value is not the correct variant type -> red`
  - delivered-by: `lt-union-codec, lt-extract-union`

- `[dod.5]` **The full conformance vector set encodes byte-equal across TS and Python (behavioral)** — The full conformance vector set encodes byte-equal across TS and Python.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx nx run apigen-conformance:conformance`
  - observable: `every host encodes each seed to identical wire bytes`
  - negative-control: `change one Python codec so a seed wire bytes differ from TS (not byte-equal) under apigen-conformance:conformance -> red`
  - delivered-by: `lt-host-ts, lt-host-python, lt-conformance-gate, lt-wire-spec, lt-host-generator`

- `[dod.6]` **The validate-Layer rejects a malformed date-time (behavioral)** — The validate-Layer rejects a malformed date-time.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 6`
  - observable: `2099-02-30 fails validation via ajv-formats`
  - negative-control: `disable ajv-formats so the malformed date-time 2099-02-30 passes validation in probe_logical.mjs --dod 6 -> red`
  - delivered-by: `lt-validate-formats, lt-scalars`

- `[dod.7]` **A schema-less any position round-trips a Date via the apigen envelope (behavioral)** — A schema-less any position round-trips a Date via the apigen envelope.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 7`
  - observable: `the decoded any value is a real Date`
  - negative-control: `remove the envelope path so the schema-less any value decodes to an empty object instead of a real Date in probe_logical.mjs --dod 7 -> red`
  - delivered-by: `lt-generator-emit, lt-scalars`

- `[dod.8]` **An unannotated source class transcodes via schema projection (Tenet 1) (behavioral)** — An unannotated source class transcodes via schema projection (Tenet 1).
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 8`
  - observable: `an unannotated class round-trips correctly`
  - negative-control: `require x-apigen-ctor so the unannotated class fails to round-trip in probe_logical.mjs --dod 8 -> red`
  - delivered-by: `lt-nominal-codec, lt-extract-nominal`

- `[dod.9]` **run/generate fail fast on 0 functions and on a missing optional rich-type dep (BUG-004) (behavioral)** — run/generate fail fast on 0 functions and on a missing optional rich-type dep (BUG-004).
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node dist/packages/apigen/cli/index.js run --source <decimal-fixture>.ts --type api-fastify`
  - observable: `decimal.js absent -> actionable startup error; 0-function source -> wrong-source error`
  - negative-control: `remove the fail-fast guard so the built bin dist/packages/apigen/cli/index.js emits a cryptic ERR_MODULE_NOT_FOUND instead of the actionable startup error -> red`
  - delivered-by: `lt-fail-fast`

- `[dod.10]` **A generated surface using a Decimal value declares its runtime dependency and runs standalone after a clean install (BUG-002) (behavioral)** — A generated surface using a Decimal value declares its runtime dependency and runs standalone after a clean install (BUG-002).
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node dist/packages/apigen/cli/index.js generate --source <decimal-fixture>.ts --type mcp --out-dir <out>`
  - observable: `generated package.json has decimal.js; server runs without --link-workspace`
  - negative-control: `omit decimal.js from the generated package.json so the dist/packages/apigen/cli/index.js generate output fails to run without --link-workspace -> red`
  - delivered-by: `lt-dep-manifest, lt-codegen-hints`

## Glossary

- **decimal.js** — the npm package apigen's generated TypeScript output depends on for an arbitrary-precision `Decimal` runtime type (consumer-facing dependency name; see dod.9/dod.10).
- **`$apigen` envelope** — the self-describing wire wrapper `{"$apigen":"<LogicalTypeId>","v":…}` used only at schema-less `any` positions (dod.7).
