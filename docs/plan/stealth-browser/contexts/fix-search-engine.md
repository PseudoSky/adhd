# fix-search-engine — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** conform-search, conform-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-engine`

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
mutates:    ["entrypoint/stealth-search/src/lib/dom.ts", "entrypoint/stealth-search/src/lib/providers.ts", "entrypoint/stealth-search/src/lib/utils.ts", "entrypoint/stealth-search/src/lib/network.ts", "entrypoint/stealth-search/src/lib/challenge.ts", "entrypoint/stealth-search/test/unit/engine/", "entrypoint/stealth-search/test/unit/providers/", "entrypoint/stealth-search/test/fixtures/engine/", "entrypoint/stealth-search/test/fixtures/providers/", "entrypoint/stealth-search/test/helpers/engine/", "packages/stealth/stealth-core-browser/src/lib/capture/dom.ts", "packages/stealth/stealth-core-browser/test/unit/capture-parsers/dom.spec.ts", "docs/plan/stealth-browser/OPEN-DECISIONS.md", "docs/plan/stealth-browser/evidence/fix-search-engine.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; OD-11 provisional resolution
