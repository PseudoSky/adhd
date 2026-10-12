# surface-hosts — STATE_NAME

**Phase:** surface · **Kind:** work · **Depends on:** surface-api · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts`

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
mutates:    ["entrypoint/stealth-browser/src/server.ts", "entrypoint/stealth-browser/src/cli.ts", "entrypoint/stealth-browser/bin/", "entrypoint/stealth-browser/package.json"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high
