# py-extract-preflight — Python extract/serve split preflight (spike, §8.3)

**Phase:** phase-3 · **Kind:** work · **Depends on:** audit-foundation · **Guard:** `grep -q '^DECISION:' docs/apigen/proposals/py-extract-serve-split-findings.md`

---

## Goal

A findings doc records, with a machine-checkable `DECISION:` line, (a) whether `apigen_python.extractor.extract_module()` has import-time side effects tied to the serving process (proposal §8.3) — i.e. whether the two-phase extract/serve split is safe as designed — and (b) the py-grpc `plugin.ts` + `grpc_server.py` run/serve shape and whether it mirrors py-flask's spawn+re-derivation.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [py-extract-preflight.1] findings doc exists

- [py-extract-preflight.2] records a DECISION line (extract_module import-time side-effect safety verdict, §8.3)
- [py-extract-preflight.3] records the py-grpc run/grpc_server shape (confirms/denies it mirrors py-flask)
---

## Reservations

```text
read_only:  ["packages/apigen/python/apigen_python/extractor.py", "packages/apigen/python/apigen_python/flask_server.py", "packages/apigen/python/apigen_python/grpc_server.py", "packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts", "packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts"]
mutates:    ["docs/apigen/proposals/py-extract-serve-split-findings.md"]
```

---

## Semantic Distillation

A SPIKE that gates all of Phase 3. It resolves the one open assumption the architecture review time-boxed out: `extractor.py` was NOT read in the review, and py-grpc's shape was NOT verified. If extraction carries serving-coupled import-time state, the split needs adjustment and this state escalates PLANNER-CLASS (a state may need inserting). If py-grpc does NOT mirror py-flask, `py-grpc-serve-split`'s scope/criteria are amended before it runs.

---

## Contract Promise

**added:** `docs/apigen/proposals/py-extract-serve-split-findings.md` with a `DECISION:` line + a `grpc_server`-shape section. **modified/deleted:** no source.

---

## Commit points

After the findings doc has a `DECISION:` line: `docs(apigen): py extract/serve split preflight findings (proposal §8.3)`.

---

## Notes for executor

SPIKE (proposal §8.3): verify extractor.py has no import-time side effects tied to serving; read py-grpc run/grpc_server shape. Records DECISION: line gating Phase 3.
