# gate-triage-absorbed — STATE_NAME

**Phase:** intake · **Kind:** work · **Depends on:** browser-cjs-umd-repair · **Guard:** `test -f docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-cli" docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-plugin-java-javalin" docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && ./node_modules/.bin/nx show projects | rg -q "\"backlog\""`

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
mutates:    ["docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md"]
```

---

## Notes for executor

Consume the in-flight debug triage verdict for the three test targets that failed the pre-commit gate after the vite 8 bump. Do not assume the bump is clean. Re-sequenced by the 2026-09-21 repair pass: the verdict is now consumed on a tree whose bump-safety fixes have landed.
