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
  - negative-control: `revert the date-time codec -> at becomes {} / input stays string -> red`
  - delivered-by: `lt-scalars, lt-extract-scalars, lt-generator-emit, lt-dispatch-integration`

- `[dod.2]` **An int64 beyond MAX_SAFE_INTEGER round-trips without precision loss (behavioral)** — An int64 beyond MAX_SAFE_INTEGER round-trips without precision loss.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx nx test apigen-runtime`
  - observable: `value survives as decimal string and decodes to an exact BigInt`
  - negative-control: `decode int64 as a JS number -> precision corrupts -> red`
  - delivered-by: `lt-scalars, lt-dispatch-integration`

- `[dod.3]` **A user class round-trips TS->wire->Python->wire->TS as a real instance on both hosts (behavioral)** — A user class round-trips TS->wire->Python->wire->TS as a real instance on both hosts.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `python3 docs/plan/apigen-logical-types/scripts/audit_lt-conformance-crosshost.py`
  - observable: `instanceof holds both hosts; fields deep-equal the seed`
  - negative-control: `remove constructor binding -> prototype-stripped object -> instanceof false -> red`
  - delivered-by: `lt-nominal-codec, lt-extract-nominal, lt-host-ts, lt-host-python`

- `[dod.4]` **A Dog|Cat position dispatches to the correct variant by wire discriminator (behavioral)** — A Dog|Cat position dispatches to the correct variant by wire discriminator.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx nx test apigen-runtime`
  - observable: `decoded value is the correct variant type`
  - negative-control: `drop discriminator tag -> wrong variant -> red`
  - delivered-by: `lt-union-codec, lt-extract-union`

- `[dod.5]` **The full conformance vector set encodes byte-equal across TS and Python (behavioral)** — The full conformance vector set encodes byte-equal across TS and Python.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx nx run apigen-conformance:conformance`
  - observable: `every host encodes each seed to identical wire bytes`
  - negative-control: `change one Python codec encoding -> byte mismatch -> red`
  - delivered-by: `lt-host-ts, lt-host-python, lt-conformance-gate`

- `[dod.6]` **The validate-Layer rejects a malformed date-time (behavioral)** — The validate-Layer rejects a malformed date-time.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx nx test apigen-runtime`
  - observable: `2099-02-30 fails validation via ajv-formats`
  - negative-control: `disable ajv-formats -> Feb 30 passes -> red`
  - delivered-by: `lt-validate-formats, lt-scalars`

- `[dod.7]` **A schema-less any position round-trips a Date via the apigen envelope (behavioral)** — A schema-less any position round-trips a Date via the apigen envelope.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx nx test apigen-logical`
  - observable: `the decoded any value is a real Date`
  - negative-control: `remove envelope path -> schema-less Date flattens to {} -> red`
  - delivered-by: `lt-generator-emit, lt-scalars`
