# express-adapter — api-express migration onto the shared adapter

**Phase:** phase-2 · **Kind:** work · **Depends on:** audit-foundation · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-api-express:test`

---

## Goal

`api-express` collapses onto the shared adapter base fastify established; the `route.ts` shim is gone; `DEBT-APIGEN-SERVE-CORE-003` is closed (a void-returning op now sends `200 {null}`, matching fastify, instead of `204` empty); the express [def:parity-gate] is green with a recorded [inv:negative-control] and a void-return fixture flagging the change.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [express-adapter.1] express composes the shared createPackageInvoker (deletes duplicated block)

- [express-adapter.2] express route.ts buildOperationIndex shim removed
- [express-adapter.3] committed express golden snapshot exists
- [express-adapter.4] express parity gate green incl. void-return-op fixture pinning undefined->null (DEBT-003)
- [express-adapter.5] negative control: express regression turns parity RED, restore GREEN
- [express-adapter.6] express collapses onto createPackageInvoker; local invoker block deleted (dod.13)
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-core-client/src/lib/plugin.ts"]
mutates:    ["packages/apigen/apigen-plugin-api-express/src/lib/run.ts", "packages/apigen/apigen-plugin-api-express/src/lib/generate.ts", "packages/apigen/apigen-plugin-api-express/src/lib/route.ts", "packages/apigen/apigen-plugin-api-express/src/test/route-parity.spec.ts", "packages/apigen/apigen-plugin-api-express/src/test/golden/express.snapshot.json", "docs/plan/apigen-serve-core/neg-control/express-adapter.patch"]
```

---

## Semantic Distillation

Mostly DELETION — the `UsePlugin`/`readUsePlugins`/`readUseOptions`/`adaptCoreLayer`/`buildInvokerForPackage`/`MountRoute`/`collectMountRoutes` block (`run.ts:84-159,165-168,182-203`) is byte-identical to fastify's and is deleted, not migrated. The shared `writeResult` gives `undefined→null` for free.

---

## Contract Promise

**modified:** `run.ts`, `generate.ts`, `route.ts`. **deleted:** `buildOperationIndex`/`resolveRoute` from `route.ts`; the duplicated invoker block from `run.ts`. **added:** `golden/express.snapshot.json` + `neg-control/express-adapter.patch`. **flagged behavior change:** `undefined→null` (`[dod.6]`), pinned by a void-return fixture.

---

## Commit points

(1) capture + commit `golden/express.snapshot.json` first; (2) migration + parity green; (3) neg-control recorded. Post-guard: `feat(apigen-plugin-api-express): migrate to shared TransportAdapter; close DEBT-APIGEN-SERVE-CORE-003`.

---

## Notes for executor

Collapse onto shared adapter; closes DEBT-003 (undefined->null). Void-return fixture pins the intentional change.


## Review folds

- **[fix:invoker-promotion] (dod.13):** express COLLAPSES onto `createPackageInvoker`; DELETE its byte-identical local `buildInvokerForPackage`/`readUsePlugins`/`readUseOptions`/`adaptCoreLayer` copy (`run.ts:84-159`) rather than keeping a divergent one.
- Stamp `plan.transport = 'http'` per [fix:transport-stamping].
