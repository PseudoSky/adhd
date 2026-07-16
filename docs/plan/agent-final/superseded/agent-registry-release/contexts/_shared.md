# Shared context — Agent Registry — Release & Closeout (worktree merge, publish, cleanup)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Glossary

- **[def:<term>]** — <definition>

## Cross-cutting invariants

- **[inv:<name>]** — <invariant that holds across all states>

## Initiative state

- Plans 1–6 of this initiative are complete and merged to `main` at commit `fd99b84` (an early code-only merge); `main` carries the five registry packages + `@adhd/agent-mcp@2.0.0` registry refactor + the credentialing/spec-mode work, and is the integration target for plans 7–9. So `merge-to-main` is already satisfied for plans 1–6 against `main` HEAD; what remains for this plan is publish + cleanup and reconciling plans 7–8 once built. Plans 7/8/9 are unbuilt.
- The hardening pass is applied across plans 7/8/9: **F-P6-6** (the release back-out gate in `scripts/check_agent_mcp_baseline.py` = union of guarded `…/src` mutate_set across all initiative plans from `plan-index.json`, fail-closed), **F-P6-10** (`test -f <file> &&` prepended to every `nx test --testFile=` audit check), **F-P6-13** (publish replaces `@adhd/*` `"*"` deps with real versions + a runtime-resolution smoke test), **F-P6-11** (the migration import-script writes the corpus to `~/.adhd/agent-mcp/registry.db`), **BUG-003** (`agent_list`/`*_list` default-limit + summary projection), and **`component_delete`**.
- `main` must not be pushed to `origin` until the LM Studio API key is rotated.
- Environment: `$SKILL` = `~/.claude/plugins/cache/sox-subagents/workflow/0.8.23/skills/plan-state-machine/scripts` (installed cache); `.mcp.json` points the `agent-mcp` server at the worktree dist `/Users/nix/dev/node/adhd-agent-registry/dist/packages/ai/agent-mcp/src/index.js`; `node_modules/@adhd/*` are symlinked to their dist builds; `~/.adhd/agent-mcp/agents.db` is migrated and is the registry server's default store; the live MCP-stdio test harness is `docs/plan/agent-registry/demo/live-test-mcp.mjs`.
