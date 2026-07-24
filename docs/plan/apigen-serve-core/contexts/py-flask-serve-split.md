# py-flask-serve-split — py-flask two-phase extract/serve split

**Phase:** phase-3 · **Kind:** work · **Depends on:** py-extract-preflight · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-py-flask:test`

---

## Goal

A two-phase split: `extractor` gains a `--emit-json` extract-only mode; the TS `py-flask` plugin spawns extract-only, parses `Operation[]`, calls the REAL `project()`, then spawns `flask_server` with `--plan`; `flask_server` builds `route_map` from the injected plan; `_route_for_op`/`_is_primitive_only_input_schema`/`_http_verb` are DELETED; the py-flask [def:parity-gate] is green vs a real spawned server with a recorded [inv:negative-control].

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
- [py-flask-serve-split.7] negative control: py-flask regression turns parity RED, restore GREEN
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "docs/apigen/proposals/py-extract-serve-split-findings.md"]
mutates:    ["packages/apigen/python/apigen_python/extractor.py", "packages/apigen/python/apigen_python/flask_server.py", "packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts", "packages/apigen/apigen-plugin-py-flask/src/test/plugin.spec.ts", "packages/apigen/apigen-plugin-py-flask/src/test/golden/py-flask.snapshot.json", "docs/plan/apigen-serve-core/neg-control/py-flask-serve-split.patch"]
```

---

## Semantic Distillation

Proposal §3d (corrected): 'inject the plan as data' is NOT small — today `plugin.ts:108-182` spawns `flask_server` which SELF-extracts (`flask_server.py:572-580`), and `flask_server.py:247-314` is a hand-maintained re-derivation of `project()`. There is no existing TS-side `Operation[]` and no IPC channel — this state builds one. The `--emit-json` extractor mode built here is SHARED infra reused by `py-grpc-serve-split`.

---

## Contract Promise

**added:** `extractor.py` `--emit-json` mode; `flask_server.py` `--plan` arg; the TS two-phase spawn in `plugin.ts`. **deleted:** `_route_for_op`, `_is_primitive_only_input_schema`, `_http_verb` from `flask_server.py`. **added:** `golden/py-flask.snapshot.json` + `neg-control/py-flask-serve-split.patch`.

---

## Commit points

(1) capture + commit `golden/py-flask.snapshot.json` first; (2) `--emit-json` + `--plan` + TS split + deletions, parity green; (3) neg-control recorded. Post-guard: `feat(apigen-plugin-py-flask): TS-computed-plan extract/serve split; delete python project() port`.

---

## Notes for executor

Two-phase extract/serve split: --emit-json extract mode; TS-side real project(); flask --plan; delete _route_for_op/_is_primitive_only_input_schema/_http_verb.
