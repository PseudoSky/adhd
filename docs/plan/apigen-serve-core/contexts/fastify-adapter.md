# fastify-adapter — api-fastify reference TransportAdapter migration

**Phase:** phase-1 · **Kind:** work · **Depends on:** serve-core-primitives, parity-harness · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-api-fastify:test`

---

## Goal

`api-fastify` is a `TransportAdapter` consuming `OpPlan`; the `route-projection` shim is gone; the dead `sendStreamSse` is wired live for `streaming:true` ops; `--use` mount ops carry full fidelity through `dispatchForPlan`'s mount branch; the fastify [def:parity-gate] is green with a recorded [inv:negative-control].

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fastify-adapter.1] fastify run.ts implements the TransportAdapter port

- [fastify-adapter.2] fastify composes the shared createPackageInvoker
- [fastify-adapter.3] sendStreamSse wired live for streaming:true ops (DEBT-002 fastify half)
- [fastify-adapter.4] route-projection resolveRoute shim removed (collapsed into OpPlan)
- [fastify-adapter.5] committed pre-migration golden snapshot exists
- [fastify-adapter.6] fastify parity gate green (real fetch-driven live server, deep-equal snapshot)
- [fastify-adapter.7] negative control: one-line adapter regression turns fastify parity RED, restore GREEN
- [fastify-adapter.8] buildInvokerForPackage block deleted from fastify (promoted to createPackageInvoker, dod.13)
- [fastify-adapter.9] fastify stamps plan.transport per-package (F3/dod.14)
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-core-client/src/lib/plugin.ts"]
mutates:    ["packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/generate.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/route-projection.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/stream.ts", "packages/apigen/apigen-plugin-api-fastify/src/test/plugin.spec.ts", "packages/apigen/apigen-plugin-api-fastify/src/test/golden/fastify.snapshot.json", "docs/plan/apigen-serve-core/neg-control/fastify-adapter.patch"]
```

---

## Semantic Distillation

The REFERENCE adapter — it exercises the whole port surface (full `--use` composition + the only working streaming projection). Folds `DEBT-APIGEN-SERVE-CORE-004` (mount fidelity: today `MountRoute{route,handler}` at `run.ts:172-175` and `collectMountRoutes` hardcode `{method:'GET',text:'',params:[]}` at `run.ts:189-210,378-392`) and the fastify half of `DEBT-APIGEN-SERVE-CORE-002` (streaming: `stream.ts:76-148` has zero call sites). Deletes the byte-identical `buildInvokerForPackage` block (`run.ts:91-166`) in favor of `createPackageInvoker`. Applies [fix:mount-through-layers] and [fix:streaming-wired].

---

## Contract Promise

**modified:** `run.ts` (becomes the adapter), `generate.ts` (renders framework source FROM `OpPlan`, not a re-derivation), `stream.ts` (`sendStreamSse` now called from `writeResult`). **deleted:** `resolveRoute`/`resolveOperation` from `route-projection.ts` (collapsed into `OpPlan`). **added:** committed pre-migration `golden/fastify.snapshot.json` + `neg-control/fastify-adapter.patch`.

---

## Commit points

(1) CAPTURE + COMMIT `golden/fastify.snapshot.json` against the CURRENT `run.ts` BEFORE any migration edit; (2) after migration + parity green; (3) after `neg-control/fastify-adapter.patch` recorded RED→GREEN. Post-guard: `feat(apigen-plugin-api-fastify): migrate to TransportAdapter/OpPlan serve-core`.

---

## Notes for executor

Reference TransportAdapter migration. Fold DEBT-004 mount fidelity + wire dead sendStreamSse live. Parity gate + negative control.


## Review folds

- **[fix:invoker-promotion] (dod.13):** DELETE `buildInvokerForPackage`/`readUsePlugins`/`readUseOptions`/`adaptCoreLayer` from this file — they now live in `createPackageInvoker`. (`run.ts:91-166`)
- **[fix:transport-stamping] (F3/dod.14):** stamp `plan.transport = 'http'` for this package so `dispatchForPlan`'s mount branch tags `Call.transport` correctly — the mechanism (not the value) is what Phase 1 must prove generic.
- **[fix:mount-through-layers] (GO §8.1):** mount ops now flow through the composed invoker (a `--use auth` layer today never sees mount routes — `run.ts:380-391` calls `m.handler(call)` directly, bypassing `invoke()`). Parity fixture class (e).
