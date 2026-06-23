# roundtrip-equivalence-gate — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** import-pipeline, skills-migration · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [roundtrip-equivalence-gate.1] import->compile->normalized diff == empty for the fixture agent (round-trip equivalence)

- [roundtrip-equivalence-gate.2] gate drives agent-registry compile <slug> --platform claude_code
- [roundtrip-equivalence-gate.3] equivalence report lists per-agent PASS/FAIL; report blocks removal
- [roundtrip-equivalence-gate.4] corrupt a migrated component -> round-trip diff fails -> gate reports FAIL
---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/import/import-agent.ts", "packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md"]
mutates:    ["packages/ai/agent-registry-migration/src/verify/equivalence-gate.ts", "packages/ai/agent-registry-migration/src/verify/normalize.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/roundtrip-equivalence.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
