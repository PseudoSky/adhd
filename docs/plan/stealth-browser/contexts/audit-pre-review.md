# audit-pre-review — STATE_NAME

**Phase:** verify · **Kind:** audit · **Depends on:** tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, mig-docs, tests-use-cases, search-hosts, search-usecases, search-examples, tracing-log-validation, search-cutover · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-pre-review`

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
mutates:    ["/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW.json", "/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW.md"]
```

---

## Notes for executor

executor=code-reviewer tier=sonnet/high; non-blind static audit, findings recorded with the audit_dod.py --phase pre-review output
