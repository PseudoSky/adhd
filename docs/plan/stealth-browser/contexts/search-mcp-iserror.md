# search-mcp-iserror — STATE_NAME

**Phase:** surface · **Kind:** work · **Depends on:** conform-search · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-mcp-iserror`

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
mutates:    ["entrypoint/stealth-search/src/server.ts", "entrypoint/stealth-search/src/errors.ts", "entrypoint/stealth-search/docs/ERRORS.md", "entrypoint/stealth-search/test/unit/hosts/", "entrypoint/stealth-search/test/unit/use-cases/hosts.spec.ts", "entrypoint/stealth-search/test/unit/errors/", "entrypoint/stealth-search/project.json", "entrypoint/stealth-search/vitest.e2e.config.ts", "docs/plan/stealth-browser/evidence/search-mcp-iserror.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; adhd ADR-0018; backlog 4909102e
