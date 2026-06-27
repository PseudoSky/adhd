# unified-credential-contract — STATE_NAME

**Phase:** contract · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase contract`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [unified-credential-contract.1] domain.ts declares credentialEnv on the unified provider config

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp-types/src/domain.ts", "packages/ai/agent-provider/src/seed/providers.ts", "packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/__tests__/roundtrip.test.ts", "packages/ai/agent-provider/src/__tests__/model-store.test.ts", "docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
