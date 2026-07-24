# fastify-adapter — STATE_NAME

**Phase:** phase-1 · **Kind:** work · **Depends on:** serve-core-primitives, parity-harness · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-api-fastify:test`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fastify-adapter.1] fastify run.ts implements the TransportAdapter port

- [fastify-adapter.2] fastify composes the shared createPackageInvoker
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-core-client/src/lib/plugin.ts"]
mutates:    ["packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/generate.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/route-projection.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/stream.ts", "packages/apigen/apigen-plugin-api-fastify/src/test/plugin.spec.ts", "packages/apigen/apigen-plugin-api-fastify/src/test/golden/fastify.snapshot.json"]
```

---

## Notes for executor

Reference TransportAdapter migration. Fold DEBT-004 mount fidelity + wire dead sendStreamSse live. Parity gate + negative control.
