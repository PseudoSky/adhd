# split-plan-repair — STATE_NAME

**Phase:** scaffold · **Kind:** work · **Depends on:** tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py split-plan-repair`

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
mutates:    ["docs/plan/stealth-browser/scripts/", "docs/plan/stealth-browser/dag.json", "docs/plan/stealth-browser/contexts/", "docs/plan/stealth-browser/README.md", "docs/plan/stealth-browser/SCOPE.md", "docs/plan/stealth-browser/USE_CASES.md", "docs/plan/stealth-browser/TOOLS.md", "docs/plan/stealth-browser/APPROVAL.md", "docs/plan/stealth-browser/APPROVAL-split.md", "docs/plan/stealth-browser/APPROVALS.md", "docs/plan/stealth-browser/SPEC-stealth-search.md", "docs/plan/stealth-browser/human-blockers.json", "docs/plan/stealth-browser/references.json", "docs/plan/stealth-browser/interfaces.json", "docs/plan/stealth-browser/DEFERRED.md", "docs/plan/plan-index.json"]
```

---

## Notes for executor

plan-builder amendment: rename core to @adhd/stealth-core-browser, port search to @adhd/stealth-search, retire surface-hosts/tracing-plugin/tracing-namespace-proof/agent-search-cutover/agent-search-relink
