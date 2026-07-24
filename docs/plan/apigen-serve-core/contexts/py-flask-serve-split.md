# py-flask-serve-split — STATE_NAME

**Phase:** phase-3 · **Kind:** work · **Depends on:** py-extract-preflight · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-py-flask:test`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [py-flask-serve-split.1] extractor gains --emit-json extract-only CLI mode

- [py-flask-serve-split.2] flask_server accepts --plan (TS-computed route/verb triples)
- [py-flask-serve-split.3] _route_for_op re-derivation deleted
- [py-flask-serve-split.4] _http_verb re-derivation deleted
- [py-flask-serve-split.5] _is_primitive_only_input_schema re-derivation deleted
- [py-flask-serve-split.6] py-flask parity gate green vs real spawned Python HTTP server
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "docs/apigen/proposals/py-extract-serve-split-findings.md"]
mutates:    ["packages/apigen/python/apigen_python/extractor.py", "packages/apigen/python/apigen_python/flask_server.py", "packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts", "packages/apigen/apigen-plugin-py-flask/src/test/plugin.spec.ts", "packages/apigen/apigen-plugin-py-flask/src/test/golden/py-flask.snapshot.json"]
```

---

## Notes for executor

Two-phase extract/serve split: --emit-json extract mode; TS-side real project(); flask --plan; delete _route_for_op/_is_primitive_only_input_schema/_http_verb.
