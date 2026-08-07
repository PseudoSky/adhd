# py-grpc-serve-split — py-grpc extract/serve split

**Phase:** phase-3 · **Kind:** work · **Depends on:** py-flask-serve-split · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-py-grpc:test`

---

## Goal

`grpc_server` accepts an injected `--plan`; its `project()` re-derivation is deleted; the TS `py-grpc` plugin does extract-only + real `project()` + spawn-with-plan (reusing the `--emit-json` mode from `py-flask-serve-split`); the py-grpc [def:parity-gate] is green vs a real spawned gRPC server with a recorded [inv:negative-control].

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [py-grpc-serve-split.1] grpc_server accepts the injected TS-computed --plan

- [py-grpc-serve-split.2] grpc project() re-derivation deleted (exact symbol confirmed by py-extract-preflight)
- [py-grpc-serve-split.3] py-grpc parity gate green vs real spawned Python gRPC server
- [py-grpc-serve-split.4] negative control: py-grpc regression turns parity RED, restore GREEN
- [py-grpc-serve-split.5] py-grpc divergent naming (namespace.capitalize()+Service) reconciled to project()'s grpc rule via injected plan (F4)
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/python/apigen_python/extractor.py", "packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts", "docs/apigen/proposals/py-extract-serve-split-findings.md"]
mutates:    ["packages/apigen/python/apigen_python/grpc_server.py", "packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts", "packages/apigen/apigen-plugin-py-grpc/src/test/plugin.spec.ts", "packages/apigen/apigen-plugin-py-grpc/src/test/golden/py-grpc.snapshot.json", "docs/plan/apigen-serve-core/neg-control/py-grpc-serve-split.patch"]
```

---

## Semantic Distillation

Scope CONFIRMED by `py-extract-preflight` (py-grpc was not read in the architecture review — do not assume it mirrors py-flask until the findings say so). SEQUENTIAL after `py-flask-serve-split` because it reuses the shared `extractor --emit-json` mode and would otherwise collide on `extractor.py`. gRPC parity driving may use `grpcurl` with a visible self-skip per [def:real-consumer-protocol].

---

## Contract Promise

**modified:** `grpc_server.py` (accept `--plan`, delete re-derivation), `plugin.ts` (two-phase spawn). **added:** `golden/py-grpc.snapshot.json` + `neg-control/py-grpc-serve-split.patch`. NOTE: the exact re-derivation symbol name to delete is confirmed by the preflight findings — amend criterion `py-grpc-serve-split.2`'s pattern (executor-class) if it differs from `_route_for`.

---

## Commit points

(1) capture + commit `golden/py-grpc.snapshot.json` first; (2) split + deletion, parity green; (3) neg-control recorded. Post-guard: `feat(apigen-plugin-py-grpc): TS-computed-plan extract/serve split`.

---

## Notes for executor

Reuse --emit-json extractor mode; inject TS-computed plan into grpc_server via --plan; delete its project() re-derivation. Scope confirmed by py-extract-preflight.


## Review folds (architect F4 — CONFIRMED divergent, resize)

- **F4:** py-grpc is NOT "same pattern, cheaper." Its Python-side naming implements a DIFFERENT algorithm from `project()`'s gRPC rule — single-segment `namespace.capitalize()+"Service"` + raw fn-name method dispatch (`grpc_server.py:397-421,448-459`) — unlike py-flask which at least re-derives the SAME HTTP algorithm. So the extract/serve split must ADDITIONALLY RECONCILE py-grpc's service/method naming to `project()`'s real grpc projection (`naming.ts:165-166`): the injected plan carries `grpc.package/service/method` and grpc_server builds its dispatch table from THAT, deleting the divergent naming. This is a second, non-trivial reconciliation — not a verify-then-proceed checkbox.
- **[fix:pygrpc-streaming-deferral] (dod.5):** rejecting streaming ops is a DOCUMENTED, filed deferral (gRPC natively streams) — file the follow-up BACKLOG item; it is a scope boundary, not a permanent capability verdict.
