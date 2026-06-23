# audit-integration — integration-phase hold point

**Phase:** audit · **Kind:** audit · **Depends on:** policy-engine-bridge · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase integration`

---

## Goal

A hold point that proves the schema + compiler-integration + retire +
policy-bridge work landed coherently BEFORE the e2e state runs: every
`architecture`, `schema`, and `integration` criterion (including the structural
"old system is gone" `grep_absent` and the `@adhd/agent-compiler` dependency
wiring) accumulates green under `--phase integration`.

This is an audit state — it carries NO deferrable items and makes NO code change.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-integration.1] integration-phase audit self-consistent (all integration criteria accumulate green)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py"]
```

---

## Notes for executor

- Run `python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase
  integration`; it must exit 0. Any FAIL is a hard block — fix the underlying
  state, do not edit the audit to pass.
- Gate on EXIT CODE (`[inv:exit-code-gate]`); the `.py` exits non-zero on any
  failing check.
