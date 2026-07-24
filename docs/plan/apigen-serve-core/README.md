# apigen transport-neutral serve-core + thin adapters

Centralize the op->wire serve loop into OpPlan + createPackageInvoker + dispatchForPlan + a TransportAdapter port in apigen-engine-runtime; migrate every transport (fastify, express, mcp, cli, py-flask, py-grpc) onto it under a byte-identical parity gate

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

_No DoD clauses yet — author them with `plan-scaffold.js add-dod`._
