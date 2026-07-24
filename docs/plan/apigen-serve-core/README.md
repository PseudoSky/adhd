# apigen transport-neutral serve-core + thin adapters

Centralize the op->wire serve loop into OpPlan + createPackageInvoker + dispatchForPlan + a TransportAdapter port in apigen-engine-runtime; migrate every transport (fastify, express, mcp, cli, py-flask, py-grpc) onto it under a byte-identical parity gate

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **OpPlan, createPackageInvoker, dispatchForPlan, and the TransportAdapter port exist in apigen-engine-runtime and are exported from its index; the 4 duplicated TS route/tool shim call sites collapse into OpPlan construction (route-projection resolveRoute/resolveOperation, express route.ts resolveRoute/buildOperationIndex, mcp tool-naming deriveToolName/findOperation, and cli-output's inline project() call are gone). (structural)** — OpPlan, createPackageInvoker, dispatchForPlan, and the TransportAdapter port exist in apigen-engine-runtime and are exported from its index; the 4 duplicated TS route/tool shim call sites collapse into OpPlan construction (route-projection resolveRoute/resolveOperation, express route.ts resolveRoute/buildOperationIndex, mcp tool-naming deriveToolName/findOperation, and cli-output's inline project() call are gone)..
