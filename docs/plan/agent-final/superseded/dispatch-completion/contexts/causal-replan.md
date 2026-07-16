# causal-replan — STATE_NAME

**Phase:** orchestrator · **Kind:** work · **Depends on:** orchestrator-harden · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-orchestrator`

---

## Goal

A guard-failure correction rewires the downstream milestone's `depends_on` onto the injected correction so a resumed cycle reaches terminal instead of `no-eligible-work`.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [causal-replan.1] orchestrator (with causal replan) builds+tests green

---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts"]
```

---

## Notes for executor

Closes DEBT-020 (causally-aware replan). Teeth: revert the rewire → resume ends `no-eligible-work`, test red (dod.5). Drive the REAL orchestrator + a mock runner that fails one guard then passes the correction; assert terminal `all-complete`. [inv:teeth].
