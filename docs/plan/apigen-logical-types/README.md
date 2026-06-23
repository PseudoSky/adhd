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
