# py-extract-preflight — STATE_NAME

**Phase:** phase-3 · **Kind:** work · **Depends on:** audit-foundation · **Guard:** `grep -q '^DECISION:' docs/apigen/proposals/py-extract-serve-split-findings.md`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [py-extract-preflight.1] findings doc exists

- [py-extract-preflight.2] records a DECISION line (extract_module import-time side-effect safety verdict, §8.3)
---

## Reservations

```text
read_only:  ["packages/apigen/python/apigen_python/extractor.py", "packages/apigen/python/apigen_python/flask_server.py", "packages/apigen/python/apigen_python/grpc_server.py", "packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts", "packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts"]
mutates:    ["docs/apigen/proposals/py-extract-serve-split-findings.md"]
```

---

## Notes for executor

SPIKE (proposal §8.3): verify extractor.py has no import-time side effects tied to serving; read py-grpc run/grpc_server shape. Records DECISION: line gating Phase 3.
