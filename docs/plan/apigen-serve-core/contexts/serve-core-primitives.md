# serve-core-primitives — serve-core primitives + TransportAdapter port

**Phase:** phase-1 · **Kind:** work · **Depends on:** none · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-engine-runtime:test`

---

## Goal

`apigen-engine-runtime` exports `OpPlan`, the `TransportAdapter` port, `createPackageInvoker`, and `dispatchForPlan`. `OpPlan` resolves each `Operation` (+ composed schema) ONCE into a transport-complete plan (http/mcp/cli/grpc + `params?` + `envelope[]` + `cliFlags` + `streaming` + `isMount`/`mountHandler?`). No transport consumes them yet — this state only builds and unit-tests the primitives.

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

## Semantic Distillation

The `Operation → wire` projection is re-authored per plugin today; this state creates the single authority. Built ON existing repo types, not new ones: `Call` (`apigen-engine-runtime/src/lib/invoke.ts:68-82`), `InvokeFn`/`InvokeOptions`/`LayerResult` (`invoke.ts:133-156`), `TransportProjection`/`project()` (`apigen-engine-naming/src/lib/naming.ts:94-177`), `ParamInfo`/`describeParams`, `MountedOperation`/`MountCapability` (`apigen-core-client/src/lib/plugin.ts:332-375`), `ApiStream`/`isApiStream` (`apigen-engine-runtime/src/lib/stream.ts`). `createPackageInvoker` absorbs the byte-identical `buildInvokerForPackage`/`readUsePlugins`/`readUseOptions`/`adaptCoreLayer` block (`apigen-plugin-api-fastify/src/lib/run.ts:91-166`). `dispatchForPlan` adds the mount-vs-source + streaming-vs-scalar branch, returning the existing `Promise<unknown> | AsyncIterable<unknown>` union (never a new streaming-incompatible signature). Contracts: [iface:op-plan], [iface:transport-adapter], [iface:create-package-invoker], [iface:dispatch-for-plan]. Mount handling honors [fix:mount-through-layers]; streaming shape honors [fix:streaming-wired].

---

## Contract Promise

**added:** `OpPlan`, `TransportAdapter`, `createPackageInvoker`, `dispatchForPlan` (+ their types), exported from `apigen-engine-runtime/src/index.ts`. `OpPlan.envelope[]` and `OpPlan.cliFlags` are COMPUTED ONCE from the composed schema (`schema.input.properties` minus `data`, cross-referenced with `x-apigen-envelope`; kebab/boolean/json valueKind for flags). **modified:** the index export list. **deleted:** nothing here — shim deletion happens in the adapter states that consume these primitives.

---

## Commit points

(1) after `op-plan.ts` + `transport-adapter.ts` type + `op-plan.spec.ts` green; (2) after `package-invoker.ts` + `dispatch-for-plan.ts` + index exports. Mandatory post-guard commit: `feat(apigen-engine-runtime): add serve-core OpPlan + TransportAdapter + createPackageInvoker + dispatchForPlan`.

---

## Notes for executor

New serve-core primitives (OpPlan, createPackageInvoker, dispatchForPlan) + TransportAdapter port. Grounded in [iface:op-plan],[iface:transport-adapter],[iface:create-package-invoker],[iface:dispatch-for-plan].
