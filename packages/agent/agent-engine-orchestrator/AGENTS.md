# AGENTS.md -- @adhd/agent-engine-orchestrator

LLM/agent-facing, factual notes for `@adhd/agent-engine-orchestrator`. Behavioural documentation lives in
[README.md](./README.md); this file records the rules an agent must follow when working in the package.

## Live tests (env-gated, paid third-party model)

Root `AGENTS.md` section 7 allows exactly one reason to gate a test behind an env flag: it calls a paid or external
third-party service. This package has one such test.

| Test file | Gate | Calls | Owner / approver |
| --- | --- | --- | --- |
| `src/__tests__/anthropic-echo-live.test.ts` | `ADHD_AGENT_LIVE_ECHO=1` (plus `ANTHROPIC_API_KEY`) | a real paid model, Anthropic `claude-haiku-5-5` at effort `high`; at most 6 requests per run (hard counter), `max_tokens` 4096, no retries | **nix (repo owner)** |

Rules for agents:

- **Never run it** unless the owner (nix (repo owner)) has given an explicit go in the current task. Do not set
  `ADHD_AGENT_LIVE_ECHO` in a shell, a script, an nx target, an `.env` file or CI configuration.
- **Off by default and off in CI.** With the gate unset the live tests are `SKIPPED` (reason names the gate and the owner)
  and the file makes no network call. With the gate set and `ANTHROPIC_API_KEY` missing the suite is red on purpose.
- **Do not gate through nx.** nx's cache key does not see the env var. The owner's command is
  `ADHD_AGENT_LIVE_ECHO=1 ANTHROPIC_API_KEY=<key> npx vitest run --config packages/agent/agent-engine-orchestrator/vite.config.ts anthropic-echo-live`
  from the repo root.
- **Keep the three records in step.** The gate, the owner and the reason are stated in this file, in `README.md`
  ("Live tests") and in the header of `anthropic-echo-live.test.ts`. The file's always-running offline half fails if
  any of the three stops naming `ADHD_AGENT_LIVE_ECHO` and `nix (repo owner)`.
- **Never print content.** The test asserts on hashes, counts and block types only; do not add output that includes a
  thinking signature, fetched page text, a request body or a key.
- **Lane.** It makes plain HTTPS calls and spawns nothing, so it is a unit-lane file (`*.test.ts`) per
  `docs/decisions/0009-test-lanes-unit-vs-e2e.md`, not an `*.e2e.test.ts`.
