# provider-credential-runtime — wire the unified credential model into the live providers

**Phase:** runtime · **Kind:** work · **Depends on:** unified-credential-contract · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/credential-inference.test.ts`

---

## Goal

The live providers resolve a single `credentialEnv`, infer the wire form, and honor
`baseURL` everywhere. After this state:

- **openai.ts** resolves `process.env[config.credentialEnv ?? "OPENAI_API_KEY"]` and
  **fails loud** ([def:fail-loud]) for a non-localhost `baseURL` with no credential —
  the `?? "lmstudio"` placeholder is **removed** (its last home; the file is also touched
  in `lmstudio-removal` for comment cleanup).
- **anthropic.ts** reads the credential from `credentialEnv` (default `ANTHROPIC_API_KEY`)
  and infers the wire form per [def:wire-form-inference], preserving
  [ref:credential-inference-idiom]; it passes `config.baseURL` to `new Anthropic({ baseURL })`.
- **claudecli.ts** exports `ANTHROPIC_BASE_URL=<config.baseURL>` into the subprocess env
  (in `buildSubprocessEnv`).
- **validation/agent.ts** gains `credentialEnv?` + `credentialType?` on the openai and
  anthropic zod schemas and `baseURL?` on anthropic (additive; the `lmstudio` schema and
  the `apiKeyEnv`/`authTokenEnv` removal are NOT in this state — see notes).

## Semantic distillation

`credentialType` overrides inference; default is inference. `useClaudeOauth` is untouched
([def:credentialEnv] note). "Non-localhost" for [def:fail-loud] = a `baseURL` whose host is
not `localhost`/`127.0.0.1`/`::1` (a bare/undefined baseURL = real OpenAI, also non-local →
must have a credential). The two new test files are the behavioral proofs:
`credential-inference.test.ts` (unit, the guard) and `integration/openai-compat-roundtrip.e2e.test.ts`
(the live [dod.6] proof — see its dedicated requirements below).

## Contract promise

- **Added:** `credentialEnv`/`credentialType` resolution in openai.ts + anthropic.ts;
  `ANTHROPIC_BASE_URL` export in claudecli.ts; `new Anthropic({ baseURL })`;
  `credentialEnv?`/`credentialType?`/`baseURL?` on the openai+anthropic zod schemas;
  `credential-inference.test.ts`; `integration/openai-compat-roundtrip.e2e.test.ts`.
- **Modified:** openai credential resolution branch (placeholder → fail-loud).
- **Deleted:** the `?? "lmstudio"` placeholder expression in openai.ts.

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [provider-credential-runtime.1] openai.ts resolves the credential from credentialEnv

- [provider-credential-runtime.2] openai.ts no longer carries the ?? "lmstudio" placeholder
- [provider-credential-runtime.3] anthropic.ts infers wire form (sk-ant-oat branch) and reads credentialEnv
- [provider-credential-runtime.4] anthropic.ts passes baseURL into the Anthropic SDK client
- [provider-credential-runtime.5] claudecli.ts exports ANTHROPIC_BASE_URL into the subprocess env
- [provider-credential-runtime.6] credential-inference unit test passes (anthropic wire-form inference + openai fail-loud)
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp-types/src/domain.ts", "packages/ai/agent-mcp/src/providers/types.ts"]
mutates:    ["packages/ai/agent-mcp/src/providers/openai.ts", "packages/ai/agent-mcp/src/providers/anthropic.ts", "packages/ai/agent-mcp/src/providers/claudecli.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/__tests__/credential-inference.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/openai-compat-roundtrip.e2e.test.ts"]
```

> **Shared-file serialization (NOT parallel).** `validation/agent.ts` and `openai.ts` are
> also mutated by `lmstudio-removal`, which `depends_on` this state — so they never run
> concurrently. This state ADDS the unified fields; `lmstudio-removal` REMOVES the legacy
> `lmstudio` schema. Keep edits additive here so the later removal is a clean delete.

---

## Commit points

1. After `credential-inference.test.ts` passes (anthropic inference + openai fail-loud):
   `git commit -m "feat(agent-mcp): unified credentialEnv resolution + wire-form inference + baseURL on every provider"`.
2. After the live `openai-compat-roundtrip.e2e.test.ts` is authored (runs by default):
   `git commit -m "test(agent-mcp): default-run openai_compat_roundtrip against the LM Studio box"`.

## Notes for executor

- **`credential-inference.test.ts` (the guard) must assert, with teeth:**
  (a) a config whose `credentialEnv` holds `sk-ant-api…` builds an `apiKey`/`x-api-key`
  Anthropic client; (b) a `sk-ant-oat…` value builds an `authToken`/`Bearer` client carrying
  `anthropic-beta: oauth-2025-04-20`; (c) an openai config with a **non-localhost** `baseURL`
  and unset `credentialEnv` throws `no credential for openai provider at <baseURL>; set <credentialEnv>`;
  (d) a localhost `baseURL` with an explicit value constructs fine. Reverting the inference
  branch or re-adding `?? "lmstudio"` MUST turn this red ([dod.2], [dod.3]).
- **`integration/openai-compat-roundtrip.e2e.test.ts` ([dod.6]) — RUNS BY DEFAULT, UNFLAGGED:**
  - Source the key from `~/.adhd/agent-mcp/.env` (the dual loader); build a real
    `OpenAIProvider` from `{ type:"openai", baseURL:"http://192.168.1.59:1234/v1", credentialEnv:"LMSTUDIO_API_KEY" }`.
  - **Assert UNCONDITIONALLY** (must pass even with the box down): the key was sourced from the
    `.env`, the provider wired the resolved apiKey, and the request is built. This is the part with
    teeth — `nc_break_credential.mjs` must turn it red.
  - **Only the network leg self-skips:** wrap the actual `chat()` round-trip so that a connection
    failure to `192.168.1.59:1234` prints `console.warn("WARNING: LM Studio box unreachable — network leg skipped")`
    and does NOT fail the test — but a NON-connection error (auth 401, bad payload) MUST fail. Never
    `it.skip` the whole test; never gate it behind an env flag. (LM Studio is a free local resource →
    the sanctioned "optional external resource" softening, not env-gating — repo CLAUDE.md.)
  - Zero secrets in the test file — read the key at runtime from the loaded env, never inline it.
- Do **not** delete `lmstudio.ts` / the zod `lmstudioProviderSchema` here — that is the next state.
