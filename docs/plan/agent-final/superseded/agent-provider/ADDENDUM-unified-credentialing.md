# ADDENDUM — Unified provider credentialing, `baseURL` everywhere, `lmstudio` removal, `.env` standard, token purge

> **STATUS — INTEGRATED & SUPERSEDED (2026-06-26).** This addendum has been folded
> into a real, executable `plan-state-machine` plan:
> **[`docs/plan/agent-provider-credentialing/`](../agent-provider-credentialing/README.md)**.
> The original owner plans (`agent-provider` plan 3, `agent-mcp-refactor` plan 6) are
> both **closed 10/10** and can no longer execute this work, so a new plan owns both the
> contract change (`@adhd/agent-mcp-types` + agent-provider registry seed) and the runtime
> change (`@adhd/agent-mcp` providers / `.env` loader / normalizer). The stale
> "pre-execution … 0/9" line below is **historical** — track progress in the new plan's
> `state.json`. §1–§5 + §8 below are the source directives; §6 (token rotation) remains
> operational (a `human-blockers.json` `lmstudio-credential` entry references the key, but
> rotation itself is NOT a plan gate, per the §6 ruling).

**Status (historical):** proposed plan amendment (pre-execution — `agent-provider` was at `current_state: scaffold-package`, 0/9) — **now integrated into `agent-provider-credentialing`**.
**Owner plans (historical):** `agent-provider` (plan 3 — the contract) + `agent-mcp-refactor` (plan 6 — the runtime wiring), both since closed. See §7 for the original split; the new `agent-provider-credentialing` plan owns the merged scope.
**Provenance:** authored 2026-06-26 by `plan-orchestrator` from a live design session; this captures the design agreed *before* it was recognized that the work belongs in the provider registry rather than an ad-hoc `agent-mcp/src/providers/*.ts` patch.
**Why an addendum:** the `agent-provider` plan defines the `ProviderAdapter` contract but its current scope omits credential/auth/`baseURL`/`.env` handling, and it *assumes* an `lmstudio` adapter (`[lmstudio_adapter_roundtrip]`). The directives below add the missing credential contract and **remove** `lmstudio` — so the plan must be amended (and its lmstudio proof reconciled) before execution.

---

## 1. Unified credential model — one `credentialEnv`, type inferred by the provider

**Today (the scattering to remove):** the provider config carries **two** credential fields — `apiKeyEnv` (→ `x-api-key`) and `authTokenEnv` (→ `Authorization: Bearer`) — and the caller must know which to set. They are the *same thing* (a credential) in two wire forms.

**Unified:** a **single** `credentialEnv: string` (optional) names the env var holding the credential. The **provider infers the wire form** from the value:

| Provider | Resolution | Inference |
|---|---|---|
| `openai` | `process.env[credentialEnv ?? "OPENAI_API_KEY"]` | always `apiKey` (Bearer) — OpenAI has one mode |
| `anthropic` | `process.env[credentialEnv ?? "ANTHROPIC_API_KEY"]` | `sk-ant-api…` → `apiKey` (`x-api-key`); `sk-ant-oat…` (OAuth) → `authToken` (Bearer); otherwise default `apiKey` |
| `claudecli` | n/a | uses the local `claude` CLI's own auth |

- **Optional escape hatch:** `credentialType?: "api_key" | "auth_token"` to override inference for an ambiguous value. Inference is the default; this is only the safety valve.
- **`useClaudeOauth` is kept unchanged** — it is a credential *source* (macOS keychain `Claude Code-credentials`), orthogonal to key-vs-token. (A future generalization could model it as `credentialSource: "env" | "keychain"`, but not in this addendum.)
- **This preserves multi-key:** `credentialEnv` is per-agent provider config, so there is **no global limit** — N agents reference N distinct env vars. **Anthropic can have 2+** concurrently (e.g. agent A `credentialEnv:"ANTHROPIC_KEY_PROD"`, agent B `credentialEnv:"ANTHROPIC_KEY_DEV"`). This was the "namespaced env remapping" the user asked for — it lives at the agent-config layer, not as global `OPENAI_API_KEY=$LMSTUDIO_API_KEY` aliasing.

## 2. `baseURL` on **every** provider

`baseURL` moves from openai/lmstudio-only to all providers (one way to point any provider at a custom endpoint / proxy / gateway):
- `openai` — already present (must end `/vN`).
- `anthropic` — `new Anthropic({ baseURL })` (for Anthropic-compatible proxies/gateways). Optional; default = SDK default.
- `claudecli` — exports `ANTHROPIC_BASE_URL=<baseURL>` into the subprocess env.

## 3. Remove the `lmstudio` provider type and wrapper

`lmstudio.ts` is a 12-line subclass of `OpenAIProvider` that only sets two defaults. It is removed entirely:
- Delete `packages/ai/agent-mcp/src/providers/lmstudio.ts`, the `lmstudio` discriminant in `validation/agent.ts`, and the `case "lmstudio"` in `providers/factory.ts`.
- **Remove the `?? "lmstudio"` placeholder** from `openai.ts` (it pollutes the real-OpenAI path and silently 401s an authed endpoint).
- LM Studio becomes a plain OpenAI provider:
  ```jsonc
  { "type": "openai", "baseURL": "http://192.168.1.59:1234/v1", "credentialEnv": "LMSTUDIO_API_KEY" }
  ```
- **Missing credential fails loud** — `"no credential for openai provider at <baseURL>; set <credentialEnv>"`. A genuine no-auth local server sets any non-empty value explicitly in `.env` (no magic placeholder).
- **Reconcile the plan's `[lmstudio_adapter_roundtrip]` proof:** there is no `lmstudio` adapter anymore. Repurpose `scripts/live-lmstudio-roundtrip.sh` as an **OpenAI-adapter round-trip against an LM Studio endpoint** (same live box, exercised through the `openai` type). Rename the criterion to `[openai_compat_roundtrip]`.

## 4. `.env` standard — the real channel for providing tokens to agent-mcp

agent-mcp already loads secrets via `import "dotenv/config"` (in `index.ts`) and providers already remap via `apiKeyEnv`/`credentialEnv` — but loading is **cwd-dependent** (`<cwd>/.env`), so the key in `packages/ai/agent-mcp/.env` is *not* found when the dist server (cwd=repo root) or `npx` (cwd=user dir) launches. Fix:

- **Deterministic dual load** (replace bare `import "dotenv/config"`): `dotenv.config()` over **`<project>/.adhd/agent-mcp/.env` then `~/.adhd/agent-mcp/.env`** — **project overrides home**. Both gitignored.
- **Secrets live ONLY in those `.env` files.** `.mcp.json` carries **no** secrets. (Note: Claude Code forwards a `.mcp.json` `env` block to the stdio child — which is *why* the raw token "worked" before — but it also means committing it leaks it. dotenv-from-disk is the correct channel; it bypasses Claude Code's 6-var spawn allowlist entirely.)
- **`.env.example`** documents the unified shape: every provider's default credential var, `baseURL`, and a **multi-key example** (two Anthropic keys via distinct `credentialEnv`).
- `DATABASE_PATH` default aligns to the central artifact convention (`tmp/agent-mcp/agents.db`, see `DEBT-WORKSPACE-ARTIFACTS-001`).

## 5. Back-compat — do not break existing `agents.db`

Stored agents use the legacy shape (`type:"lmstudio"`, `apiKeyEnv`, `authTokenEnv`). Add a **normalize-on-load** step in the zod parse (preprocess), so old rows keep working and the canonical schema is the new unified one:
- `type:"lmstudio"` → `type:"openai"` with `baseURL ??= LMSTUDIO_BASE_URL`, `credentialEnv ??= "LMSTUDIO_API_KEY"`.
- `apiKeyEnv` / `authTokenEnv` → `credentialEnv` (prefer `apiKeyEnv`; else `authTokenEnv`, with inference handling the wire form).

No data migration required; no breakage. (Optional follow-up: a one-time `agent-registry-migration`-owned rewrite to the canonical shape.)

## 6. Leaked-token purge + rotation (security — operational)

The LM Studio token was committed raw in **3 tracked files** (`.mcp.json`, `packages/ai/agent-mcp/run-e2e.mjs`, `packages/ai/agent-mcp/SESSION-CONTEXT.md`) across **4 commits**, and commit `8ca504d` **is an ancestor of `origin/main`** (already pushed). Status:
- **Done (HEAD-forward):** all 3 files redacted; `.mcp.json` remapped to the env standard with relative paths (commit `55fc42c`). `packages/ai/agent-mcp/.env` is correctly gitignored/untracked — **not** a git leak (the real key belongs there locally).
- **Mandatory:** **rotate the LM Studio key** — it is exposed on `origin/main`; rotation is the actual fix. Put the new key in `~/.adhd/agent-mcp/.env`.
- **Pending explicit approval:** a true history purge rewrites the 4 secret-bearing commits **+ all local commits** and needs a **force-push to `origin/main`** (rules forbid an unprompted force-push). Given rotation kills the exposed value, the pushed-history rewrite is optional hygiene.

## 7. Cross-plan ownership (do NOT ad-hoc patch `providers/*.ts`)

| Item | Owner plan | Notes |
|---|---|---|
| Unified `ProviderConfig` + `credentialEnv` + inference rule in the `ProviderAdapter` contract (`@adhd/agent-mcp-types`) | **`agent-provider`** (plan 3) | amend scope to include credential/auth/`baseURL`; reconcile/rename the `lmstudio` proof (§3) |
| Drop `lmstudio` type from the registry/contract | **`agent-provider`** | the type disappears from the canonical schema |
| Wire the contract into live `agent-mcp` providers — delete `lmstudio.ts`, credential inference in `anthropic.ts`/`openai.ts`, remove the placeholder, deterministic `.env` loader, back-compat normalizer | **`agent-mcp-refactor`** (plan 6) | this is where the runtime change actually lands |
| Token purge / rotation | operational (this addendum §6) | not a plan deliverable; tracked here |

## 8. Proposed DoD additions

- `agent-provider`: the `ProviderAdapter` contract names `credentialEnv` (+ optional `credentialType`), `baseURL`, and **no** `lmstudio` type; an `anthropic` adapter proves `sk-ant-api…`→`x-api-key` and `sk-ant-oat…`→Bearer inference against a real value; `[openai_compat_roundtrip]` replaces `[lmstudio_adapter_roundtrip]`.
- `agent-mcp-refactor`: a default-running test proves (a) a missing credential **fails loud** for a non-localhost `openai` baseURL, (b) the dual `.env` load resolves project-over-home, (c) a legacy `type:lmstudio`/`apiKeyEnv` agent normalizes and still runs, and (d) a **live round-trip** through the real `openai` adapter against the LM Studio box (`192.168.1.59:1234/v1`) with the key sourced from `~/.adhd/agent-mcp/.env` — proving the key flows end-to-end with **zero secrets in any tracked file**.
