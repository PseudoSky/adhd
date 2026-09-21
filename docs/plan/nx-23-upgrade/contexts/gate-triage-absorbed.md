# gate-triage-absorbed — STATE_NAME

**Phase:** intake · **Kind:** work · **Depends on:** upgrade-baseline · **Guard:** `test -f docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-cli" docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-plugin-java-javalin" docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && ./node_modules/.bin/nx show projects | rg -q "\"backlog\""`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [gate-triage-absorbed.1] The triage verdict record exists

- [gate-triage-absorbed.2] The verdict record covers the apigen-cli target
- [gate-triage-absorbed.3] The verdict record covers the java-javalin target
- [gate-triage-absorbed.4] The verdict record covers the backlog target
- [gate-triage-absorbed.5] The project graph loads with the affected targets resolvable
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json"]
mutates:    ["docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md"]
```

---

## Notes for executor

Consume the in-flight debug triage verdict for the three test targets that failed the pre-commit gate after the vite 8 bump. Do not assume the bump is clean.
