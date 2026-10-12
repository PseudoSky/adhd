# prod-public-api — STATE_NAME

**Phase:** surface · **Kind:** work · **Depends on:** surface-api · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-public-api`

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
read_only:  ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/lib/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts"]
mutates:    ["entrypoint/stealth-browser/src/legacy.ts", "entrypoint/stealth-browser/src/index.ts", "entrypoint/stealth-browser/src/test/unit/public-api/"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high
