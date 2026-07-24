# apigen transport-neutral serve-core + thin adapters

Centralize the op->wire serve loop into OpPlan + createPackageInvoker + dispatchForPlan + a TransportAdapter port in apigen-engine-runtime; migrate every transport (fastify, express, mcp, cli, py-flask, py-grpc) onto it under a byte-identical parity gate

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **OpPlan, createPackageInvoker, dispatchForPlan, and the TransportAdapter port exist in apigen-engine-runtime and are exported from its index; the 4 duplicated TS route/tool shim call sites collapse into OpPlan construction (route-projection resolveRoute/resolveOperation, express route.ts resolveRoute/buildOperationIndex, mcp tool-naming deriveToolName/findOperation, and cli-output's inline project() call are gone). (structural)** — OpPlan, createPackageInvoker, dispatchForPlan, and the TransportAdapter port exist in apigen-engine-runtime and are exported from its index; the 4 duplicated TS route/tool shim call sites collapse into OpPlan construction (route-projection resolveRoute/resolveOperation, express route.ts resolveRoute/buildOperationIndex, mcp tool-naming deriveToolName/findOperation, and cli-output's inline project() call are gone)..

- `[dod.2]` **Every TS transport (fastify, express, mcp, cli) is a TransportAdapter consuming OpPlan and passes its parity gate: a pre-migration golden capture of the live server/CLI deep-equals the post-migration capture, driven through the REAL consumer protocol. (behavioral)** — Every TS transport (fastify, express, mcp, cli) is a TransportAdapter consuming OpPlan and passes its parity gate: a pre-migration golden capture of the live server/CLI deep-equals the post-migration capture, driven through the REAL consumer protocol..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-mcp,apigen-plugin-cli-output`
  - observable: `all four transports' parity specs pass; each asserts deep-equality against its committed golden snapshot`
  - delivered-by: `fastify-adapter, express-adapter, mcp-adapter, cli-adapter`

- `[dod.3]` **Each transport migration has a recorded negative control: reverting the migration (or injecting a one-line regression) turns that transport's parity suite RED, and restoring turns it GREEN. (behavioral)** — Each transport migration has a recorded negative control: reverting the migration (or injecting a one-line regression) turns that transport's parity suite RED, and restoring turns it GREEN..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `node docs/plan/apigen-serve-core/scripts/run-audit.js --phase final`
  - observable: `each adapter's negative-control criterion reports the mutate variant RED and the restored variant GREEN`
  - delivered-by: `fastify-adapter, express-adapter, mcp-adapter, cli-adapter`

- `[dod.4]` **MCP composes createPackageInvoker/makeValidateLayer for the first time; malformed MCP tool input is rejected with invalid_argument (was silently accepted) — a flagged, tested behavior change closing BUG-APIGEN-SERVE-CORE-001. (behavioral)** — MCP composes createPackageInvoker/makeValidateLayer for the first time; malformed MCP tool input is rejected with invalid_argument (was silently accepted) — a flagged, tested behavior change closing BUG-APIGEN-SERVE-CORE-001..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test`
  - observable: `a real @modelcontextprotocol/sdk client sending schema-violating input receives an invalid_argument error instead of a domain result`
  - delivered-by: `mcp-adapter`

- `[dod.5]` **Streaming is wired live: a streaming:true op emits SSE frames over fastify and progressive content over MCP; CLI, py-flask, and py-grpc explicitly reject a streaming op rather than silently mis-serializing an AsyncIterable. (behavioral)** — Streaming is wired live: a streaming:true op emits SSE frames over fastify and progressive content over MCP; CLI, py-flask, and py-grpc explicitly reject a streaming op rather than silently mis-serializing an AsyncIterable..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-api-fastify,apigen-plugin-mcp,apigen-plugin-cli-output`
  - observable: `fastify streaming fixture yields SSE frames; mcp yields progressive content; cli/py streaming fixture returns an explicit rejection`
  - delivered-by: `fastify-adapter, mcp-adapter, cli-adapter`

- `[dod.6]` **The express undefined->null response-encoding gap (DEBT-APIGEN-SERVE-CORE-003) is closed via the shared adapter writeResult, pinned by a void-return-op fixture flagged as an intentional, tested behavior change. (structural)** — The express undefined->null response-encoding gap (DEBT-APIGEN-SERVE-CORE-003) is closed via the shared adapter writeResult, pinned by a void-return-op fixture flagged as an intentional, tested behavior change..
