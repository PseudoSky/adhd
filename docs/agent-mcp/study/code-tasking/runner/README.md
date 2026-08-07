# runner/ — one-command study harness

Replays the whole code-tasking battery against **any** provider/model and records
the full responses, so adding a model is one command instead of hand-built JSONL.

## Files

| file | role |
|---|---|
| `plan.json` | provider-agnostic test definitions: the 7 agent specs (system prompt + mcpServers + permissions) and 18 tests (mode + prompts). Derived verbatim from the recorded `tests/test-*/mcp.jsonl`; the provider is **injected at runtime**, so the only thing that varies between models is the model. |
| `run-study.mjs` | a `@modelcontextprotocol/sdk` client that spawns `npx -y @adhd/agent-mcp@latest` over stdio, creates each agent with the chosen provider, runs the tests (single / multi-turn session / orchestration), unwraps the `{task_id,status,result}` envelope, cleans up the agents, and writes `results/runs.<label>.jsonl`. |
| `grade.py` | a **conservative** rubric auto-grader (teeth-bearing signal checks per scenario). A `CHECK` means "inspect by hand", not a fail — final verdicts are hand-graded in `results/grades.manual.json`. |

## Usage

```bash
# from the repo root or worktree (Node resolves the SDK from the repo node_modules)
node docs/agent-mcp/study/code-tasking/runner/run-study.mjs \
  --label qwen35-9b-hiq --provider lmstudio \
  --model qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8 --tests all

node docs/agent-mcp/study/code-tasking/runner/run-study.mjs \
  --label anthropic-sonnet46 --provider anthropic --model claude-sonnet-4-6 \
  --tests 1,3,4,5,9,10,11,12,13,14,15,16,17

python3 docs/agent-mcp/study/code-tasking/runner/grade.py qwen35-9b-hiq   # or --all
```

Flags: `--label` (output name) · `--provider lmstudio|anthropic` · `--model` · `--tests all|csv`
· `--timeout <ms>` · `--dry-run`.

## Notes / gotchas (learned the hard way)

- **LM Studio creds come from `.mcp.json`, not the ambient env.** The runner reads
  `mcpServers["agent-mcp-published"].env.LMSTUDIO_API_KEY` and overrides any stray
  `process.env.LMSTUDIO_API_KEY` — a leaked OpenAI `sk-proj-…` key there makes LM Studio
  return `401 Malformed token`. Anthropic auth uses `authTokenEnv: ANTHROPIC_AUTH_TOKEN`.
- **`SSE_PORT=0`** so the spawned server never collides with an interactive one (the BUG-001
  fix also makes a collision non-fatal).
- **Orchestration (test 14)** has the `lead` spawn its own child `agent-mcp` (stdio) that
  inherits the DB + creds; its sub-agents (`synth-coder`, `coder`) are created with the run's
  provider. Capable models (sonnet-4.6, qwen3.5-9b) tend to call a **bare** `agent`/`task`
  tool and trip the orchestrator's `missing server prefix` validation — recorded as `ERROR`,
  excluded from the capability tally (it's instruction-following of the tool convention, not
  coding ability).
- **Usage telemetry** is persisted by the server itself (`task_usage`); export it from the DB
  (see `../results/README.md`) and join on the prompt text. The harness records the response
  text; the DB is the source of truth for tokens/latency/`tool_call_count`.
