# python-host — STATE_NAME

**Phase:** v2-host-contract · **Kind:** work · **Depends on:** canonical-descriptor, conformance-vectors, gateway · **Guard:** `python3 -m pytest packages/apigen/python -q`

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
read_only:  []
mutates:    ["packages/apigen/python/apigen_python/extractor.py", "packages/apigen/python/apigen_python/runtime.py", "packages/apigen/python/apigen_python/plugin_echo.py", "packages/apigen/python/apigen_python/gateway_adapter.py", "packages/apigen/python/pyproject.toml"]
```

---

## Notes for executor

SPEC §14 (H1): minimal REAL second host so the §13.1 sidecar-gateway IPC + partial-availability are proven against a true foreign runtime, not a TS stub (fixes R9). Python -extractor (source->descriptor), -runtime (invoke/validate/dispatch), one echo plugin, gateway IPC adapter. Must pass apigen-conformance vectors.
