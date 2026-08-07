# backcompat-normalizer — normalize legacy agents.db rows on load

**Phase:** backcompat · **Kind:** work · **Depends on:** provider-credential-runtime, lmstudio-removal · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/backcompat-normalize.test.ts`

---

## Goal

Existing stored agents keep working with **no data migration**. After this state
([def:normalize-on-load]):

- `validation/agent.ts` wraps the provider-config parse in a zod `preprocess` that rewrites
  legacy shapes into the canonical unified shape **before** discrimination:
  - `type:"lmstudio"` → `type:"openai"` with `baseURL ??= process.env["LMSTUDIO_BASE_URL"] ?? "http://localhost:1234/v1"` and `credentialEnv ??= "LMSTUDIO_API_KEY"`.
  - `apiKeyEnv` → `credentialEnv` (preferred); else `authTokenEnv` → `credentialEnv`.
- A real `~/.adhd/agent-mcp/agents.db` (when present) loads every provider row without error.

## Semantic distillation

This **depends_on both** runtime states: the canonical schema must already be `lmstudio`-free
(`lmstudio-removal`) and already carry `credentialEnv` (`provider-credential-runtime`) for the
preprocess to map legacy rows INTO it. The preprocess is the **only** place the dropped
`type:"lmstudio"`/`apiKeyEnv`/`authTokenEnv` shapes are still accepted — on input, coerced, never
stored canonical. It is also the seam in [ref:provider-discriminated-union].

## Contract promise

- **Added:** a `z.preprocess(...)` wrapper around `providerConfigSchema`; `backcompat-normalize.test.ts`.
- **Modified:** `validation/agent.ts` parse entrypoint (legacy shapes coerced before discrimination).

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [backcompat-normalizer.1] validation/agent.ts adds a normalize-on-load preprocess for legacy rows

- [backcompat-normalizer.2] legacy lmstudio/apiKeyEnv config normalizes and the real agents.db rows parse
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts"]
mutates:    ["packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/__tests__/backcompat-normalize.test.ts"]
```

> **Serialization.** `validation/agent.ts` is shared with the two runtime states this one
> `depends_on`; serial execution means no conflict — add the preprocess on top of the
> already-unified, lmstudio-free schema.

---

## Commit points

1. After `backcompat-normalize.test.ts` proves legacy coercion AND the real-DB rows parse:
   `git commit -m "feat(agent-mcp): normalize-on-load shim for legacy lmstudio/apiKeyEnv agents (no migration)"`.

## Notes for executor

- **`backcompat-normalize.test.ts` must, with teeth:**
  (a) parse `{ type:"lmstudio", apiKeyEnv:"LMSTUDIO_API_KEY", model:"x" }` → assert the result is
  `type:"openai"`, `credentialEnv:"LMSTUDIO_API_KEY"`, `baseURL` defaulted; (b) parse
  `{ type:"anthropic", authTokenEnv:"MY_TOK", model:"x" }` → `credentialEnv:"MY_TOK"`;
  (c) **open the real `~/.adhd/agent-mcp/agents.db`** (read-only; skip-with-warning ONLY if the
  file is absent on this box, never silently) and parse every stored provider config through the
  schema — all must validate. Removing the preprocess MUST turn (a)/(b) red ([dod.5]).
- Read the real DB read-only; do not write to it. Use better-sqlite3 in readonly mode.
