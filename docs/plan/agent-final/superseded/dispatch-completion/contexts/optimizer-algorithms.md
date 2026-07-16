# optimizer-algorithms — STATE_NAME

**Phase:** algorithms · **Kind:** work · **Depends on:** opt-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-core-optimizer`

---

## Goal

The Bitmask DP / Tree DP / SA / HLFET cascade ships ONLY if data justifies it; otherwise a HELD marker records the measured greedy-vs-naive baseline and the plan still reaches terminal.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [optimizer-algorithms.1] optimizer (algorithms held or shipped) builds+tests green

---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-core-optimizer/src/lib/algorithms/index.ts"]
```

---

## Notes for executor

DATA-GATED (P7): unblock only on ≥3 real cycles showing >15% greedy shortfall vs recorded naive baseline. Unmet → write a HELD marker (dod.10); terminal does not require this state. Also finish DEBT-011 orphan-stub cleanup if any residue. No speculative algorithm build.
