# search-tracing-fixes — STATE_NAME

**Phase:** surface · **Kind:** work · **Depends on:** search-mcp-iserror, fix-search-build, fix-search-output, fix-search-fetch, fix-search-engine, fix-core-parsers, fix-core-lifecycle, fix-core-errors, fix-tripwire · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-tracing-fixes`

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
mutates:    ["entrypoint/stealth-search/src/tracing.ts", "entrypoint/stealth-search/src/telemetry.ts", "entrypoint/stealth-search/src/cli.ts", "entrypoint/stealth-search/src/host-flags.ts", "entrypoint/stealth-search/src/host-errors.ts", "entrypoint/stealth-search/src/host-projection.ts", "entrypoint/stealth-search/src/api.ts", "entrypoint/stealth-search/src/index.ts", "entrypoint/stealth-search/test/unit/hosts/", "entrypoint/stealth-search/test/unit/tracing/", "entrypoint/stealth-search/docs/OBSERVABILITY.md", "entrypoint/stealth-search/docs/CONFIGURATION.md", "entrypoint/stealth-search/README.md", "docs/plan/stealth-browser/evidence/search-tracing-fixes.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; fixes the failed tracing-log-validation
