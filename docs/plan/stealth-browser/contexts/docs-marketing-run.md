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
mutates:    ["packages/stealth/stealth-core-browser/docs/", "packages/stealth/stealth-core-browser/AGENTS.md", "packages/stealth/stealth-core-browser/llms.txt", "packages/stealth/stealth-core-browser/CHANGELOG.md", "packages/stealth/stealth-core-browser/README.md", "entrypoint/stealth-search/docs/", "entrypoint/stealth-search/AGENTS.md", "entrypoint/stealth-search/llms.txt", "entrypoint/stealth-search/CHANGELOG.md", "entrypoint/stealth-search/README.md"]
```

---

## Notes for executor

executor=doc-steward tier=sonnet/medium
