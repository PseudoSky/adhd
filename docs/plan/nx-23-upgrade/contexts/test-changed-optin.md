# test-changed-optin — Fail-safe file-level test selection delivered

**Phase:** tests · **Kind:** work · **Depends on:** test-selection-revalidated · **Guard:** `node -e "const s=require(\"./package.json\").scripts;if(!s[\"test:changed\"]||!s[\"test:related\"])process.exit(1)" && ./node_modules/.bin/nx show projects | rg -q "backlog" && test -f docs/plan/nx-23-upgrade/TEST-SELECTION.md`

---

## Goal

A developer can run only the tests covering a changed file, cross-package coverage is preserved, and an empty selection fails loudly.

---

## Semantic distillation

- INVERTED DESIGN, deliberately: the full suite stays the default; the narrow path is explicit opt-in. A forgotten override then runs MORE tests than needed — a wall-clock cost — instead of silently running fewer, which is a correctness cost.
- The full suite is reached from five-plus invocation sites (commit gate, CI workflows, the all-targets script, the release path). None of them may inherit a narrowed default.
- Zero selected is a FAILURE. This is the one guard that must never be relaxed.
- `^build` stays in the test path. It was measured inconclusive for speed and is load-bearing for the four child-process projects.

---

## Contract promise

```text
added:    ["the opt-in fast-path scripts","docs/plan/nx-23-upgrade/TEST-SELECTION.md"]
modified: ["package.json"]
deleted:  []
```

---

## Commit points

- Commit the fast path + TEST-SELECTION.md post-guard.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [test-changed-optin.1] The opt-in fast path is exposed as a workspace script

- [test-changed-optin.2] The file-scoped fast path is exposed as a workspace script
- [test-changed-optin.3] The full suite remains the default: the standard test target is unchanged
- [test-changed-optin.4] A zero-selection run fails loudly instead of reporting success
- [test-changed-optin.5] A cross-package change still selects tests in the dependent package
- [test-changed-optin.6] The test-selection design record exists
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", ".githooks/pre-commit", ".githooks/README.md"]
mutates:    ["package.json", "docs/plan/nx-23-upgrade/TEST-SELECTION.md", "docs/plan/nx-23-upgrade/scripts/check-zero-selection.mjs", "docs/plan/nx-23-upgrade/scripts/check-cross-package-selection.mjs"]
```

---

## References & interfaces

- [ref:fail-safe-fast-path] — the narrow fast path exits non-zero when it selects zero tests; the default path is never narrowed

---

## Notes for executor

Deliver the fail-safe design: full suite stays the default, the fast path is explicit opt-in, and a run that selects zero tests must FAIL rather than report success.
