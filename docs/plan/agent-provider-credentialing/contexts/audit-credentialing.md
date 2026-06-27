# audit-credentialing — STATE_NAME

**Phase:** audit · **Kind:** audit · **Depends on:** lmstudio-removal · **Guard:** `python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase audit`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-credentialing.1] no LM Studio secret in any tracked file (incl docs/mcp-env/PROPOSAL.md); .env paths gitignored

- [audit-credentialing.2] live openai_compat_roundtrip drives the real openai adapter (unconditional credential flow; network leg self-skips loud if box down)
- [audit-credentialing.3] teeth: breaking openai credential resolution makes the unconditional credential-flow assertions fail RED even with the LM Studio box down
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py", "docs/plan/agent-provider-credentialing/scripts/check-no-secrets.sh"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
