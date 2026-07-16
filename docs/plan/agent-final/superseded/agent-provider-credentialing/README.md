# Agent Provider — Unified Credentialing, baseURL Everywhere, lmstudio Removal, .env Standard

> ## ⚠ Reconciliation (2026-06-28): largely SUPERSEDED by `docs/mcp-env/SPEC.md`
>
> The credentialing **runtime** goals of this plan were implemented out-of-band — as a
> single in-package change to `@adhd/agent-mcp` (+ `@adhd/agent-mcp-types`) driven by
> [`docs/mcp-env/SPEC.md`](../../mcp-env/SPEC.md) — **not** by executing this plan's state
> machine (all states remain `pending`; `state.json` was never advanced). Build + tests
> green; verified live via the MCP tools (OAuth-token Anthropic agent → real completion;
> DeepSeek `openai` agent → authenticated).
>
> **Done by the SPEC (overlaps this plan's intent):** unified credential field, `baseURL`
> everywhere + `/v1` runtime normalization, **`lmstudio` type removed** (+ no
> `?? "lmstudio"` placeholder), deterministic multi-file `.env` load, **legacy
> normalize-on-load shim**, fail-loud on missing non-localhost secret, Anthropic
> wire-form inference (`sk-ant-api…`/`sk-ant-oat…`), keychain subsystem removed.
>
> **Deltas from this plan's design (intentional):**
> - Credential field is **`provider.env.{secret,base_url,model}`** (env-var *names*), **not**
>   `credentialEnv` + `credentialType`.
> - `.env` hierarchy is **`<project>/.env` → `<project>/.adhd/.env` → `~/.adhd/.env`**, not
>   `<project>/.adhd/agent-mcp/.env` over `~/.adhd/agent-mcp/.env`.
> - Env-name guard added (`ADHD_AGENT_`-prefix, input-only).
>
> **Still OUTSTANDING (NOT covered by the SPEC) — the only reason to keep this plan:**
> - The **`@adhd/agent-provider` registry SEED** (`provider_providers` / `provider_models` /
>   platform-binding / tool-format rows) — `dod.1`'s registry-seed clause.
> - This plan's specific live proof `[openai_compat_roundtrip]` against the LM Studio box
>   (`dod.6`) — the SPEC proved the path with DeepSeek + Anthropic instead.
> - `dod.7` zero-secrets scrub that explicitly names this directory's `PROPOSAL.md`.
>
> **Recommendation:** either retire this plan, or re-scope it to just the registry-seed +
> its live proof. Do not execute it as-is — it would re-do (and conflict with) shipped work.

---

This plan integrates `ADDENDUM-unified-credentialing.md` (authored against the now-closed
`agent-provider` (Plan 3) and `agent-mcp-refactor` (Plan 6), which can no longer execute it)
into a single executable state machine. It unifies the two scattered provider credential
fields (`apiKeyEnv` + `authTokenEnv`) into one `credentialEnv` whose wire form the provider
infers, puts `baseURL` on every provider, **removes the `lmstudio` provider type** (LM Studio
becomes a plain `openai` provider with `baseURL` + `credentialEnv`), establishes a deterministic
dual `.env` load (`<project>/.adhd/agent-mcp/.env` over `~/.adhd/agent-mcp/.env`), and adds a
normalize-on-load shim so existing `agents.db` rows keep working. It spans three packages:
`@adhd/agent-mcp-types` (the contract), `@adhd/agent-mcp` (the runtime), and `@adhd/agent-provider`
(the registry seed). Token rotation/purge (ADDENDUM §6) is operational, **not** a plan deliverable.

## Consumer

An **agent author / MCP host operator** who configures providers in agent definitions and supplies
credentials through `.env`. Today they must know whether a credential is an `apiKeyEnv` or an
`authTokenEnv`, cannot point `anthropic`/`claudecli` at a custom gateway, must use a bespoke
`lmstudio` type for a local OpenAI-compatible server, and silently get a `"lmstudio"` placeholder
key on a mistyped OpenAI endpoint. After this change they set one `credentialEnv` per provider, the
provider infers the wire form, every provider accepts a `baseURL`, LM Studio is just `openai`, and a
missing credential on a real endpoint **fails loud** instead of 401-ing silently.

## Value delta

- **Before:** two credential fields the caller must disambiguate; `baseURL` only on openai/lmstudio;
  a separate `lmstudio` type + 12-line wrapper + a `?? "lmstudio"` placeholder that pollutes the
  real-OpenAI path; cwd-dependent `.env` loading that misses the key under `dist`/`npx`; a leaked
  LM Studio token in tracked files.
- **After:** one `credentialEnv` (+ optional `credentialType` override) with provider-inferred wire
  form; `baseURL` on every provider; no `lmstudio` type anywhere; deterministic dual `.env` load
  (project over home); legacy rows normalized on load with zero migration; zero secrets in any
  tracked file.

## Glossary

These are domain terms the consumer (an agent author / MCP host operator) owns and uses directly;
they appear in DoD outcome text deliberately, not as leaked implementation mechanics.

- **credentialEnv / credentialType** — the unified provider-config fields the consumer authors.
- **apiKeyEnv / authTokenEnv** — the legacy provider-config fields the consumer's existing agents
  still carry; the normalize-on-load shim accepts them.
- **agents.db** — the consumer's real on-disk agent registry at `~/.adhd/agent-mcp/agents.db`, the
  back-compat target.
- **lmstudio** — the retired provider *type*; the consumer migrates these configs to `openai`.

## Definition of Done

- `[dod.1]` **The unified provider contract (`@adhd/agent-mcp-types` `domain.ts` AND the agent-mcp zod schema) declares a single `credentialEnv` plus optional `credentialType` on openai+anthropic and `baseURL` on every provider; the `lmstudio` type is absent from the type union, the zod discriminated union, the provider factory, the registry seed, and there is no `?? "lmstudio"` placeholder anywhere. (structural)** — proven by `audit_credentialing.py --phase audit` positive greps (credentialEnv/credentialType/baseURL present) + negative greps (no `lmstudio` discriminant, no placeholder).
  - delivered-by: `unified-credential-contract, provider-credential-runtime, lmstudio-removal`

- `[dod.2]` **The anthropic adapter infers the credential wire form from the value: `sk-ant-api…` resolves to an `x-api-key` client and `sk-ant-oat…` resolves to an `Authorization: Bearer` client with the `oauth-2025-04-20` beta header. (behavioral)**
  - given: an anthropic provider config whose `credentialEnv` names an env var holding each credential form
  - when: `AnthropicProvider` is constructed and its client auth is inspected
  - then: `sk-ant-api…` builds an `apiKey`/`x-api-key` client; `sk-ant-oat…` builds an `authToken`/`Bearer` client carrying the oauth beta header
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/credential-inference.test.ts`
  - observable: test passes — the asserted auth mode/header matches the credential prefix for each form
  - negative-control: revert the inference branch (always `apiKey`) in the anthropic adapter and re-run `agent-mcp credential-inference.test.ts` → the `sk-ant-oat…` Bearer assertion in that test fails red
  - delivered-by: `provider-credential-runtime`

- `[dod.3]` **A missing credential fails loud for a non-localhost `openai` `baseURL` instead of silently sending a `"lmstudio"` placeholder. (behavioral)**
  - given: an `openai` provider config with a non-localhost `baseURL` and an unset `credentialEnv`
  - when: the provider is constructed / a request is attempted
  - then: it throws `no credential for openai provider at <baseURL>; set <credentialEnv>`; a localhost `baseURL` with an explicit value still succeeds
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/credential-inference.test.ts`
  - observable: the non-localhost/unset case throws the named error; the localhost/explicit case constructs successfully
  - negative-control: re-introduce `?? "lmstudio"` in the agent-mcp `openai.ts` and re-run `agent-mcp credential-inference.test.ts` → the fail-loud assertion in that test fails red
  - delivered-by: `provider-credential-runtime`

- `[dod.4]` **The deterministic dual `.env` load resolves `<project>/.adhd/agent-mcp/.env` over `~/.adhd/agent-mcp/.env` (project overrides home). (behavioral)**
  - given: the same variable set to different values in a project `.adhd/agent-mcp/.env` and a home `~/.adhd/agent-mcp/.env`
  - when: the deterministic dual loader runs
  - then: `process.env` holds the project value
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/dotenv-load.test.ts`
  - observable: the resolved value equals the project file's value, not the home file's
  - negative-control: swap the loader's project/home order (home loaded first) and re-run `agent-mcp dotenv-load.test.ts` → the project-over-home assertion in that test fails red
  - delivered-by: `dotenv-dual-load`

- `[dod.5]` **A legacy agent config (`type:"lmstudio"`, `apiKeyEnv`/`authTokenEnv`) normalizes on load to the unified shape and still validates — proven against the real `~/.adhd/agent-mcp/agents.db`. (behavioral)**
  - given: a legacy `type:"lmstudio"` / `apiKeyEnv` config object AND the real `~/.adhd/agent-mcp/agents.db` (when present)
  - when: each is parsed through the unified zod schema's normalize-on-load preprocess
  - then: the legacy config becomes `type:"openai"` with `credentialEnv` set and `baseURL` defaulted, and every provider row read from the real DB parses without error
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/backcompat-normalize.test.ts`
  - observable: the normalized object matches the unified shape; the real-DB rows all parse
  - negative-control: remove the preprocess and re-run `agent-mcp backcompat-normalize.test.ts` → the legacy-config coercion assertion in that test fails red
  - delivered-by: `backcompat-normalizer`

- `[dod.6]` **A live round-trip through the real `openai` adapter against the LM Studio box (`192.168.1.59:1234/v1`), credential sourced from `~/.adhd/agent-mcp/.env`, returns a real completion — the `[openai_compat_roundtrip]` proof that replaces the retired `[lmstudio_adapter_roundtrip]`. (behavioral)**
  - given: a valid LM Studio credential present in `~/.adhd/agent-mcp/.env` (human-blocker `lmstudio-credential`)
  - when: the real `OpenAIProvider` is built from `{ type:"openai", baseURL, credentialEnv }` and `chat()` is called
  - then: the credential-flow assertions (key sourced from the `.env`, provider wiring, request build) pass **unconditionally**; when the box is reachable a real completion (≥1 content chunk) is returned; when unreachable **only** the network leg self-skips with a printed `WARNING`
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/integration/openai-compat-roundtrip.e2e.test.ts`
  - observable: stdout shows the credential-flow assertions passing; either a completion is asserted or a single explicit `WARNING: LM Studio box unreachable — network leg skipped` line is printed — never a silent pass, never a masked code fault
  - negative-control: run `nc_break_credential.mjs` against the agent-mcp `openai.ts` adapter and re-run `agent-mcp openai-compat-roundtrip.e2e.test.ts` → the **unconditional** credential-flow assertion in that test fails red even with the box down
  - delivered-by: `provider-credential-runtime`

- `[dod.7]` **Zero secrets in any tracked file: the LM Studio credential value appears in no git-tracked content — explicitly including `docs/mcp-env/PROPOSAL.md` — and the `.env` destinations are gitignored. (structural)** — proven by `check-no-secrets.sh`: greps all `git ls-files` content (PROPOSAL.md named explicitly) for the credential value (read from the local `.env` at audit time, never hardcoded) + secret patterns, and `git check-ignore`s the `.env` paths.
  - delivered-by: `audit-credentialing`

- `[dod.8]` **`baseURL` is honored by every provider at runtime: anthropic passes `config.baseURL` to `new Anthropic({ baseURL })`, claudecli exports `ANTHROPIC_BASE_URL` into the subprocess env, and openai keeps its versioned `baseURL`. (structural)** — proven by `audit_credentialing.py --phase audit` AST/grep that each provider references `baseURL` at the documented site.
  - delivered-by: `provider-credential-runtime`

## Execution model

1. **Parallel execution?** Yes, one branch: `dotenv-dual-load` (env) runs in parallel with the
   `provider-credential-runtime → lmstudio-removal` runtime chain after the contract state — they
   share no mutable files. The runtime pair is **serial** (both edit `validation/agent.ts` and
   `openai.ts`). Everything converges at the final audit.
2. **Which agent(s) implement?** A single TypeScript-capable executor per state (no per-track split
   needed — the one parallel branch touches a disjoint file set).
3. **Do agents review — who, and when?** The mandatory `audit-credentialing` state is the review/hold
   point; it drives every behavioral entrypoint and the structural/secret scans before `done`. The
   requester (team-lead) accepts "done" on the audit's `[dod.N] PASS` lines.
4. **Automatic dispatch?** No — the executor is a separate agent and the live proof needs a
   human-provisioned credential. Hand off with the Dispatch line.

## Status

```bash
node "$SKILL/state-transition.js" docs/plan/agent-provider-credentialing <current_state> --start
node "$SKILL/orchestrate-plan.js" docs/plan/agent-provider-credentialing --dispatch
```

See `state-machine.md` for the rendered topology and `human-blockers.json` for the pre-execution
punch list (LM Studio credential in `~/.adhd/agent-mcp/.env`).
