# test-changed-optin — STATE_NAME

**Phase:** tests · **Kind:** work · **Depends on:** test-selection-revalidated · **Guard:** `node -e "const s=require(\"./package.json\").scripts;if(!s[\"test:changed\"]||!s[\"test:related\"])process.exit(1)" && ./node_modules/.bin/nx show projects | rg -q "backlog" && test -f docs/plan/nx-23-upgrade/TEST-SELECTION.md`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [test-changed-optin.1] The opt-in fast path is exposed as a workspace script

---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", ".githooks/pre-commit", ".githooks/README.md"]
mutates:    ["package.json", "docs/plan/nx-23-upgrade/TEST-SELECTION.md"]
```

---

## Notes for executor

Deliver the fail-safe design: full suite stays the default, the fast path is explicit opt-in, and a run that selects zero tests must FAIL rather than report success.
