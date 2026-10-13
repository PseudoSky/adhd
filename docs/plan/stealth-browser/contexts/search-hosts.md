# search-hosts — STATE_NAME

**Phase:** surface · **Kind:** work · **Depends on:** search-verbs, search-tracing, core-seam · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-hosts`

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
mutates:    ["entrypoint/stealth-search/src/server.ts", "entrypoint/stealth-search/src/cli.ts", "entrypoint/stealth-search/src/host-flags.ts", "entrypoint/stealth-search/src/host-errors.ts", "entrypoint/stealth-search/bin/", "entrypoint/stealth-search/src/test/unit/hosts/", "entrypoint/stealth-search/package.json", "pnpm-lock.yaml", "docs/plan/stealth-browser/evidence/naming-decision.md"]
```

---

## Notes for executor

typescript-pro sonnet/high; CLI and MCP hosts, O12 commander probe first
