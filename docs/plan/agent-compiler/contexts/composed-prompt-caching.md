# composed-prompt-caching — STATE_NAME

**Phase:** cache · **Kind:** work · **Depends on:** platform-markdown-emit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [composed-prompt-caching.1] writes composed_prompts row keyed by context hash

---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/emit/markdown.ts"]
mutates:    ["packages/ai/agent-compiler/src/cache/composed-prompt-cache.ts", "packages/ai/agent-compiler/src/compile.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/compile-cache.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
