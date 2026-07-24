# serve-core-primitives — STATE_NAME

**Phase:** phase-1 · **Kind:** work · **Depends on:** none · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-engine-runtime:test`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [serve-core-primitives.1] createPackageInvoker exported from apigen-engine-runtime index

- [serve-core-primitives.2] dispatchForPlan exported from apigen-engine-runtime index
- [serve-core-primitives.3] OpPlan type exported from apigen-engine-runtime index
- [serve-core-primitives.4] TransportAdapter port exported from apigen-engine-runtime index
- [serve-core-primitives.5] OpPlan carries the precomputed cliFlags table (proposal §3a)
- [serve-core-primitives.6] apigen-engine-runtime unit suite (incl. op-plan.spec) passes
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-core-client/src/lib/plugin.ts", "packages/apigen/apigen-engine-runtime/src/lib/invoke.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts", "packages/apigen/apigen-engine-runtime/src/lib/describe-params.ts", "packages/apigen/apigen-engine-runtime/src/lib/validate-layer.ts", "packages/apigen/apigen-engine-runtime/src/lib/stream.ts"]
mutates:    ["packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts", "packages/apigen/apigen-engine-runtime/src/index.ts", "packages/apigen/apigen-engine-runtime/src/lib/op-plan.spec.ts"]
```

---

## Notes for executor

New serve-core primitives (OpPlan, createPackageInvoker, dispatchForPlan) + TransportAdapter port. Grounded in [iface:op-plan],[iface:transport-adapter],[iface:create-package-invoker],[iface:dispatch-for-plan].
