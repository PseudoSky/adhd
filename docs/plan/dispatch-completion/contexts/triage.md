# triage — STATE_NAME

**Phase:** triage · **Kind:** audit · **Depends on:** none · **Guard:** `python3 docs/plan/dispatch-completion/scripts/audit_dispatch-completion.py --phase triage`

---

## Goal

Both preconditions are confirmed landed (V0) and the carried DEBT ledger is reconciled against live source before any work begins.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [triage.1] EXEC-001 landed: the tool-call skipped-stub warn is gone from orchestrator

- [triage.2] PUBLISH-001 landed: duplicate short alias @adhd/dispatch-spec removed from tsconfig
---

## Reservations

```text
read_only:  []
mutates:    ["scripts/audit_triage.py"]
```

---

## Notes for executor

Verify [def:preconditions]: run the triage criteria (BUG-DISPATCH-EXEC-001 = the `is not wired into` warn is gone from orchestrator.ts; BUG-DISPATCH-PUBLISH-001 = the duplicate `@adhd/dispatch-spec` alias is gone from tsconfig.base.json). If either fails, HALT and report — this plan depends on them. Then re-verify every row in `BACKLOG.md` against live source (six items already drifted to fixed — see RECONCILIATION.md §C); if EXEC-001 shipped the full `dispatch-tools` package, narrow/drop the `dispatch-tools` state. Confirm `dispatch-base-types` is still orphaned (0 importers) before scheduling its delete.
