# enforcement-plugin — STATE_NAME

**Phase:** enforcement · **Kind:** work · **Depends on:** policy-inheritance · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [enforcement-plugin.1] plugin exports configSchema (zod)

- [enforcement-plugin.2] plugin exports createPlugin + registers via hooks.registerEnforcement(pre:model_request)
- [enforcement-plugin.3] enforcement test: rate policy throws through real IHookRegistry.enforce(pre:model_request)
---

## Reservations

```text
read_only:  ["packages/ai/agent-policy/src/store/policy-template-store.ts", "packages/ai/agent-policy/src/store/agent-policy-store.ts"]
mutates:    ["packages/ai/agent-policy/src/plugin/index.ts", "packages/ai/agent-policy/src/plugin/rate-policy.ts", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/__tests__/enforcement-plugin.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
