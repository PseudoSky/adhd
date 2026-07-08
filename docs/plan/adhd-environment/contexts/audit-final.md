# audit-final — STATE_NAME

**Phase:** audit · **Kind:** audit · **Depends on:** refactor-agent-mcp, audit-runtime · **Guard:** `true`

---

## Goal

Verify that every clause of the Definition of Done is satisfied. Each criterion below proves one `[dod.N]` clause.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] All 6 packages build successfully — proves [dod.1]
- [audit-final.2] adhd-env init generates valid YAML — proves [dod.2]
- [audit-final.3] adhd-env set + build round-trips correctly — proves [dod.3]
- [audit-final.4] adhd-env build writes snapshot to correct path — proves [dod.4]
- [audit-final.5] Typed Environment constructs with params object — proves [dod.5]
- [audit-final.6] contentHash test vector matches canonical value — proves [dod.6]
- [audit-final.7] Old config.ts is removed — proves [dod.7]
- [audit-final.8] build() returns EnvironmentSnapshot with set/get/configPath/write — proves [dod.8]
---

## Reservations

```text
read_only:  []
mutates:    ["scripts/audit_audit-final.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
