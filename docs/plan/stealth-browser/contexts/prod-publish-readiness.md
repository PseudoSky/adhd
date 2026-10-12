# prod-publish-readiness — STATE_NAME

**Phase:** release · **Kind:** work · **Depends on:** readme-rewrite · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-publish-readiness`

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
read_only:  ["entrypoint/stealth-browser/README.md", "entrypoint/stealth-browser/CHANGELOG.md", "entrypoint/stealth-browser/dist/", "PUBLISHING.md"]
mutates:    ["docs/plan/stealth-browser/evidence/publish-dry-run.txt", "entrypoint/stealth-browser/package.json"]
```

---

## Notes for executor

executor=platform-engineer tier=sonnet/medium
