# docs-marketing-run — STATE_NAME

**Phase:** docs · **Kind:** work · **Depends on:** gates-rerun · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py docs-marketing-run`

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
mutates:    ["entrypoint/stealth-browser/docs/", "entrypoint/stealth-browser/AGENTS.md", "entrypoint/stealth-browser/llms.txt", "entrypoint/stealth-browser/CHANGELOG.md", "entrypoint/stealth-browser/README.md"]
```

---

## Notes for executor

executor=doc-steward tier=sonnet/medium
