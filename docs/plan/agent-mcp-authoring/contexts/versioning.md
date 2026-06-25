# versioning — STATE_NAME

**Phase:** compat · **Kind:** work · **Depends on:** compat-shim · **Guard:** `npx --yes nx build agent-mcp`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [versioning.1] package.json is agent-mcp@2.0.0 with CHANGELOG noting breaking required->optional systemPrompt + permanent compat-shim

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/package.json", "packages/ai/agent-mcp/CHANGELOG.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
