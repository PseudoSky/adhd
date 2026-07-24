# py-grpc-serve-split — STATE_NAME

**Phase:** phase-3 · **Kind:** work · **Depends on:** py-flask-serve-split · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-py-grpc:test`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/python/apigen_python/extractor.py", "packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts", "docs/apigen/proposals/py-extract-serve-split-findings.md"]
mutates:    ["packages/apigen/python/apigen_python/grpc_server.py", "packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts", "packages/apigen/apigen-plugin-py-grpc/src/test/plugin.spec.ts", "packages/apigen/apigen-plugin-py-grpc/src/test/golden/py-grpc.snapshot.json"]
```

---

## Notes for executor

Reuse --emit-json extractor mode; inject TS-computed plan into grpc_server via --plan; delete its project() re-derivation. Scope confirmed by py-extract-preflight.
