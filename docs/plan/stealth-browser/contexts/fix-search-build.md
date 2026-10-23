# fix-search-build — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** search-mcp-iserror · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-build`

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
mutates:    ["entrypoint/stealth-search/package.json", "entrypoint/stealth-search/project.json", "entrypoint/stealth-search/vite.config.ts", "entrypoint/stealth-search/tsconfig.build-bin.json", "entrypoint/stealth-search/bin/", "entrypoint/stealth-search/scripts/", "entrypoint/stealth-search/src/server.ts", "entrypoint/stealth-search/test/unit/build/", "docs/plan/stealth-browser/evidence/fix-search-build.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; I-35
