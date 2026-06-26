# live-model-e2e — AGENT_MCP_LIVE-gated real-model composition journey across a PROVIDER MATRIX

**Phase:** e2e · **Kind:** work · **Depends on:** composition-journey-e2e · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts`

---

## Goal

A REAL model walks the composition journey end-to-end across a **real-provider
matrix** — NEVER a scripted/mock provider (CLAUDE.md verification standard #5;
closes COVERAGE.md §B for the authoring lane). Behind `AGENT_MCP_LIVE=1`,
`authoring-live-e2e.test.ts` runs the same composition journey
(`component_search → agent_define → agent → task`) once **per available
provider** in:

1. **`anthropic`** with `useClaudeOauth: true` — reads the Claude Max OAuth token
   from the macOS keychain (no API key needed). Config: `{ type:"anthropic",
   model, useClaudeOauth:true }`.
2. **`claudecli`** — drives the local `claude` CLI via stream-json. Config:
   `{ type:"claudecli", claudePath?, model }`.
3. **`lmstudio`** — OpenAI-compatible local server. Config: `{ type:"lmstudio",
   model, baseURL: process.env.LMSTUDIO_BASE_URL }`.

For each enabled provider the test asserts the **model-independent invariants**:
the model ITSELF issues a real `agent_define` tool call (a scripted provider could
not fake it), and the task completes (`stopReason: completed`). **Per-provider
availability gates each case** (skip-not-fail when a provider's creds/service are
absent); the WHOLE matrix is **skipped (not failed)** when `AGENT_MCP_LIVE` is
unset, so CI stays offline. The tooth: seeding an EMPTY component registry forces
`agent_define` to raise `COMPONENT_NOT_FOUND` on every enabled provider and the
live run fails — proving each provider drives real composition through the
registry, not a canned reply.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [live-model-e2e.1] AGENT_MCP_LIVE=1 real model across the {anthropic(useClaudeOauth keychain), claudecli, lmstudio(baseURL)} provider matrix through component_search->agent_define->agent->task; per-provider availability gates each case (skip-not-fail); whole matrix skips when AGENT_MCP_LIVE unset; empty registry forces COMPONENT_NOT_FOUND on every enabled provider

---

## Human-blockers (per-provider prerequisites)

These gate the matrix cases; each absent provider SKIPS (never fails). See
`human-blockers.json`:

- `live-provider-anthropic-oauth` — Claude Max OAuth in the macOS keychain
  (`useClaudeOauth:true`) or `ANTHROPIC_API_KEY`.
- `live-provider-claudecli` — the `claude` CLI installed + authenticated, on PATH.
- `live-provider-lmstudio` — LM Studio's OpenAI-compatible server running at
  `LMSTUDIO_BASE_URL`.

How to enable each (documented in README §dod.6 + USAGE):

```bash
# anthropic (Claude Max OAuth, no API key)
#   sign in to Claude Code so the OAuth token is in the login keychain, then:
AGENT_MCP_LIVE=1 npx nx test agent-mcp --testFile=.../authoring-live-e2e.test.ts

# claudecli (local claude CLI)
#   ensure `claude` is on PATH + logged in; optionally CLAUDE_CLI_PATH=/abs/claude
AGENT_MCP_LIVE=1 npx nx test agent-mcp --testFile=.../authoring-live-e2e.test.ts

# lmstudio (OpenAI-compatible local server)
LMSTUDIO_BASE_URL=http://localhost:1234/v1 AGENT_MCP_LIVE=1 \
  npx nx test agent-mcp --testFile=.../authoring-live-e2e.test.ts
```

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts"]
```

---

## Notes for executor

- **NEVER a scripted/mock provider on the live path.** This is the exact gap
  CLAUDE.md #5 warns about: a scripted/mock provider can fake a tool call the real
  model can't make. Every matrix case uses the REAL provider + Orchestrator (mock
  nothing under test); assert against model-independent invariants (the
  `agent_define` call happened, `stopReason: completed`) — not on exact model
  wording, which varies by provider.
- **Per-provider availability gate (skip-not-fail).** Probe each provider's
  prerequisite at runtime and `it.skip` the case when absent — anthropic: keychain
  OAuth token / `ANTHROPIC_API_KEY` present; claudecli: `claude` resolvable on
  PATH; lmstudio: `LMSTUDIO_BASE_URL` set and `/models` reachable. A missing
  provider must SKIP its case, never red the suite. The DoD requires the matrix
  RUNS when enabled — do not let a perpetually-skipped matrix masquerade as passing
  (the test must actually execute the journey on at least the providers whose
  blockers are satisfied).
- **Whole-matrix offline gate.** Gate the entire describe block on
  `AGENT_MCP_LIVE` so CI stays green and offline; skip cleanly (do not fail) when
  unset.
- **Empty-registry is the negative control with teeth, per provider.** Seed zero
  components so the model's `agent_define` resolves to `COMPONENT_NOT_FOUND` on
  EVERY enabled provider. If a run still "passes," the assertion is theater.
- **Trust exit codes, not stdout.** Do not gate on `… | grep -q passed`; key on the
  runner's exit status (a teardown segfault can print "passed" — project memory:
  better-sqlite3 vitest teardown). Await completion on a bounded deadline, never
  `sleep`.
- Reuse the public-surface harness from `composition-journey-e2e`; this state swaps
  the run-step provider for each live provider in the matrix and adds the
  empty-registry negative control. Adds only `authoring-live-e2e.test.ts` (test
  file — no src change; stays inside the modification manifest).
