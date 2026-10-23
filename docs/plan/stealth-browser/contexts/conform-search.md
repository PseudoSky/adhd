# conform-search — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** main-merge · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py conform-search`

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
mutates:    ["entrypoint/stealth-search/", "tools/nx-plugins/build/executors/typecheck-spec/stealth-search.baseline.json", "docs/plan/stealth-browser/evidence/conform-search.md"]
```

---

## Notes for executor

executor=haiku tier=haiku; mechanical codemod. Escalate to sonnet only when typecheck-spec stays red after two attempts. [inv:test-layout]
