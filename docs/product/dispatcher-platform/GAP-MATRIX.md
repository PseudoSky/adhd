# Gap Matrix — Dispatcher Platform (receipts version)

Companion to `ROADMAP.md`, which carries the readable summary table. This file carries the full
evidence citation for every row. All citations were produced by opening the cited file, not by
grep alone, per this repo's evidence rules. State as of 2026-08-12.

Columns: **Capability | Criticality | Current state | Owning package | Closing epic | Evidence**

---

## Correction (2026-08-12, post-publication)

Rows 1, 2, 3, 4, and 7 below were originally filed as `absent` on the false premise that "`.mcp.json` does not forward provider credentials → agents structurally cannot call tools." That premise is false — see `ROADMAP.md`'s Correction log for the full evidence trail. A live `mcp__agent-mcp__agent_list` call confirmed a real, currently-registered agent (`sox-typescript-impl`) is already federated, today, to a real filesystem MCP server (`@modelcontextprotocol/server-filesystem`, genuine surgical `edit_file`, verified against the installed package source at `.../node_modules/@modelcontextprotocol/server-filesystem/dist/lib.js:144-209`) and a real shell MCP server (`mcp-shell`, allowlist-gated via `security.yaml`). These four rows are corrected below from `absent`/`partial` to `present (via MCP federation, not default)`. `agent-store-tools`' 15 seed rows genuinely have no in-house executor — that part of the original evidence stands — but the *conclusion* that the capability is absent was wrong: the real gap is that federation is opt-in per agent rather than a default, and `git` is confirmed excluded from the one shell path that exists.

### 1. Filesystem read/write/edit executor reachable by a dispatched agent
- **Criticality:** important (downgraded from blocker — see Correction above)
- **State:** present via MCP federation, not default
- **Owner:** `agent-engine-orchestrator/src/clients/registry.ts` (federated `@modelcontextprotocol/server-filesystem`); `agent-store-tools` rows remain metadata-only/decorative
- **Epic:** EPIC-DISPATCH-01-capability-floor
- **Evidence:** Live tool call `mcp__agent-mcp__agent_list` → agent `sox-typescript-impl`'s `mcpServers.filesystem` = `npx @modelcontextprotocol/server-filesystem` rooted at a real directory, `allowedTools` including `read_text_file`, `write_file`, `edit_file`, `create_directory`, `move_file`. The installed package's `edit_file` implementation (`.../node_modules/@modelcontextprotocol/server-filesystem/dist/lib.js:144-209`, `applyFileEdits`) is genuine surgical string-replace: exact-match first, whitespace-tolerant line-window matching as fallback, atomic temp-file+rename write. Enforcement of `allowedTools` is real, not advisory: `agent-engine-orchestrator/src/clients/registry.ts:123-136` (`isToolHidden`/`assertToolAllowed`) is invoked at `orchestrator.ts:343,683` immediately before every `callTool`. Separately, `TOOL_SEEDS` at `packages/agent/agent-store-tools/src/seed/tools.ts:19-125` (15 rows including `file_read`/`file_write`) still have zero in-house executor code anywhere in `packages/agent` or `entrypoint/agent-mcp` — that finding is unchanged, but it describes a *decorative, unused DB registry parallel to the real gating path*, not an absence of capability. Filed as `DEBT-DISPATCH-CAPFLOOR-001` (registry wiring, still VALID) rather than as a capability-floor blocker.

### 2. Shell/bash execution as an agent tool (not just a pass/fail guard)
- **Criticality:** important (downgraded from blocker — see Correction above)
- **State:** present via MCP federation, not default (git excluded)
- **Owner:** federated `mcp-shell` (per-agent `mcpServers` config); `dispatch-orchestrator` (guard exec only, unrelated in-DAG mechanism)
- **Epic:** EPIC-DISPATCH-01-capability-floor
- **Evidence:** Live `agent_list` confirms `sox-typescript-impl`'s `mcpServers.shell` = `/Users/nix/dev/go/bin/mcp-shell`, gated by `tools/mcp-shell/security.yaml`. Direct read of that file: `allowed_executables: [npx, npm, yarn, echo, ls, which, head, tail, wc, grep, pwd, true, false]` — real, working, allowlisted shell exec, model-callable as an MCP tool (not just a DAG-level guard). `git` is explicitly absent from that allowlist, and `use_shell_execution: false` means no pipes/`&&`/redirection even for allowed executables — confirmed real limitation, tracked as `FEAT-DISPATCH-CAPFLOOR-003`. `dispatch-orchestrator`'s own `orchestrator.ts:368-402`/`:1146-1155` guard-exec path is a separate, narrower DAG-authoring mechanism (exit-code-only, output discarded) — unaffected by this correction, still tracked as `DEBT-DISPATCH-CAPFLOOR-002`.

### 3. Code search (glob/grep) available to a dispatched agent
- **Criticality:** important (downgraded from blocker — see Correction above)
- **State:** present via MCP federation, not default
- **Owner:** filesystem MCP server's `search_files` tool; `agent-store-tools`' `file_glob`/`file_grep` rows remain unexecuted
- **Epic:** EPIC-DISPATCH-01-capability-floor
- **Evidence:** `sox-typescript-impl`'s federated filesystem server's `allowedTools` includes `search_files`, live-confirmed via `agent_list`; `mcp-shell`'s allowlist also grants `grep` directly (`security.yaml`, see row 2). `file_glob`/`file_grep` seed rows in `agent-store-tools/src/seed/tools.ts:19-125` remain unexecuted in-house — same pattern as row 1, decorative not blocking.

### 4. Surgical (diff/patch) file edit
- **Criticality:** important (downgraded from blocker — see Correction above)
- **State:** present via MCP federation, not default; `dispatch-orchestrator`'s own DAG-authoring verb remains whole-file overwrite only
- **Owner:** federated `@modelcontextprotocol/server-filesystem`'s `edit_file`; `packages/dispatch/dispatch-orchestrator` (separate, narrower `fs.scaffold` DAG verb)
- **Epic:** EPIC-DISPATCH-01-capability-floor
- **Evidence:** `edit_file`'s `applyFileEdits` (installed package source, `.../node_modules/@modelcontextprotocol/server-filesystem/dist/lib.js:144-209`) does genuine exact-match-then-whitespace-tolerant-line-window string replacement, atomically written — this is agent-callable today for any agent with the filesystem server federated. Distinct and narrower: `orchestrator.ts:563-577`'s `fs.scaffold` case (the only file-write verb in `dispatch-orchestrator`'s own `OperationAction` switch) is still whole-file `fsp.writeFile` overwrite only, no `fs.edit`/`fs.patch`/`fs.replace` case exists — that finding is unchanged and is a real, narrower DAG-authoring gap (not an agent-editing capability gap). Rescoped in the roadmap to `FEAT-DISPATCH-CAPFLOOR-002`, LOW priority.

### 5. Agent can consume external MCP servers (tool federation)
- **Criticality:** blocker
- **State:** present
- **Owner:** `packages/agent/agent-engine-orchestrator/src/clients/registry.ts`
- **Epic:** EPIC-DISPATCH-01-capability-floor
- **Evidence:** `registry.ts:76-117` dispatches to real Stdio/Http/Sse MCP clients; `:11-95` (`McpClientRegistry`) confirms the federation mechanism genuinely works per-agent via an `mcpServers` config map; `:130-166` gates tools via `allowedTools`/`disallowedTools` (`assertToolAllowed`/`isToolHidden`). Any conformant third-party MCP server drops in without new orchestrator code.

### 6. Multi-provider model calls (anthropic / openai-compatible / claudecli)
- **Criticality:** blocker
- **State:** present (no gemini)
- **Owner:** `packages/agent/agent-engine-orchestrator/src/providers`
- **Epic:** EPIC-DISPATCH-02-substrate-trust
- **Evidence:** `anthropic.ts:180-329`, `openai.ts:124-228`, `claudecli.ts` (492 lines, drives the local `claude` binary as a subprocess) all confirmed as real, working provider adapters with real streaming and parallel tool-use. No Gemini provider file exists.

### 7. Provider credentials wired into this repo's MCP config
- **Criticality:** important (downgraded from blocker — corrected 2026-08-12, see `ROADMAP.md` Correction log)
- **State:** present, via a `.env`-file fallback — not explicitly forwarded in `.mcp.json`
- **Owner:** `entrypoint/agent-mcp/src/config.ts` (`loadEnvHierarchy()`) + `.mcp.json`
- **Epic:** EPIC-DISPATCH-02-substrate-trust
- **Evidence:** `.mcp.json:1-15` read directly (re-verified 2026-08-12) confirms the agent-mcp server's `env` block forwards only `ADHD_ENV_SCOPE`/`ADHD_AGENT_CONFIG`/`ADHD_AGENT_REGISTRY_DB_PATH`; zero `ADHD_AGENT_*_SECRET` forwarding — that narrow fact is correct and unchanged. But it does **not** mean credentials fail to resolve: `entrypoint/agent-mcp/src/config.ts:27-37` calls `loadEnvHierarchy()` (`entrypoint/agent-mcp/src/utils/load-env.ts:1-46`) unconditionally at module load, before `Environment` is constructed or any secret is looked up. That function populates `process.env` via `dotenv` from `~/.adhd/.env` (no override), then `<cwd>/.adhd/.env` (override), then `<cwd>/.env` (override) — independent of what the spawning `.mcp.json` entry forwards. `env.resolveEnvName()` (`packages/environment/environment-core-node/src/environment.ts:317-320`) then reads the now-populated `process.env` directly. This mechanism was restored under `BUG-MCP-CREDENTIALS-001` (a prior refactor, commit `b38369f3`, had deleted it) and is landed in code today. So both the repo-root and the `agent-mcp-published` `.mcp.json` entries (the latter having no `env` block at all) resolve identical credentials via this same fallback, as long as `~/.adhd/.env` defines the needed secret. The real residual gap is narrower: no *explicit* forwarding in `.mcp.json` means the failure mode `No credential for <provider>` still reproduces on any machine/process without a populated `~/.adhd/.env` (CI, a different user, a stripped-env launch) — a defense-in-depth/explicitness gap, not a live blocker on the standard launch path. Backlog: `DEBT-MCP-CREDENTIALS-001` (re-corrected CRITICAL→MEDIUM; merged duplicate: legacy-key `agent-mcp-001`, re-verified ALREADY-SOLVED against current code).

### 8. `@adhd/agent-mcp` installable from npm
- **Criticality:** blocker
- **State:** fixed upstream since original filing; no e2e gate keeps it fixed
- **Owner:** `entrypoint/agent-mcp`, `packages/agent/agent-store-tools`
- **Epic:** EPIC-DISPATCH-02-substrate-trust
- **Evidence:** Re-verified live 2026-08-12: `npm view @adhd/agent-mcp version` = 2.3.0; a real clean-room `npm install @adhd/agent-mcp` in a fresh `mktemp -d` exits 0, installs 208 packages, 0 vulnerabilities. `npm view @adhd/agent-mcp dependencies` shows `@adhd/agent-store-tools ^2.2.0`, and store-tools' max published version is 2.2.0 — the range resolves. `npm pack @adhd/agent-engine-orchestrator@latest` (2.3.0) yields 175 real files including `src/tools`, `src/validation`, `src/providers`, `src/engine`, `src/clients`, `src/plugins`. Original ETARGET/empty-tarball symptoms (`BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001`, `BUG-RELEASE-DISTROOT-FILES-001`) no longer reproduce, but no CI gate (`BUG-CI-PUBLISH-MISSING-GATES-001`) exists to prevent recurrence on the next dependency bump — hence "partial/keep-fixed" rather than fully closed.

### 9. dispatch's provider model bridged to the canonical agent-core-provider system
- **Criticality:** blocker
- **State:** absent
- **Owner:** `packages/dispatch/dispatch-base-spec` + `packages/agent/agent-core-provider`
- **Epic:** EPIC-DISPATCH-02-substrate-trust
- **Evidence:** Re-verified 2026-08-12 by direct source read: `dispatch-base-spec/src/lib/types.ts:85` still declares its own `ProviderType` union (`'anthropic'|'openai'|'claudecli'`), fully parallel to `agent-core-provider`'s representation; `dispatch-orchestrator/src/lib/agent-runner.ts:232-274` still contains the hand-maintained `toAgentMcpProviderConfig()` snake_case→camelCase translation shim, invoked at line 394. No registry-ref bridge exists. DeepSeek dispatch confirmed non-functional 2026-07-16 per backlog history. Backlog: `MIG-PROVIDER-001`.

### 10. Session continuity across milestones / across `run` invocations
- **Criticality:** blocker
- **State:** absent
- **Owner:** `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts`
- **Epic:** EPIC-DISPATCH-03-session-continuity
- **Evidence:** `agent-runner.ts:400-412` — `fire()` sends only `{agent_name, prompt}` to the MCP `task` tool; no `session_id` field exists on the call or anywhere on `DispatchUnit`/`MilestoneDag` in `dispatch-base-spec`. Every dispatch is a cold, single-shot task.

### 11. Multi-turn persistent sessions in the substrate
- **Criticality:** blocker
- **State:** present
- **Owner:** `packages/agent/agent-store-runtime` + `agent-engine-orchestrator`
- **Epic:** EPIC-DISPATCH-03-session-continuity
- **Evidence:** `SessionStore`/`TaskStore` wired at `entrypoint/agent-mcp/src/server.ts:71-72`; `session_id` plumbed at `:632-685`. Real, SQLite-backed, and confirmed working — the gap is that dispatch never opts into it (row 10).

### 12. Human-in-the-loop pause/approve reachable from a dispatch run
- **Criticality:** blocker
- **State:** unwired
- **Owner:** `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts`
- **Epic:** EPIC-DISPATCH-03-session-continuity
- **Evidence:** HITL works for sessioned tasks (`request_human_input` builtin → `awaiting_input` → `resumeToken` → `task_resume`, fully wired end-to-end per the agent-mcp substrate audit) — but `orchestrator.ts:504-510` hard-throws `'request_human_input is not supported for ephemeral tasks'`, and every dispatch-fired task is ephemeral (row 10). HITL is structurally unreachable from dispatch today, not merely undocumented.

### 13. Per-action permission gate (allow/deny/ask) before destructive ops
- **Criticality:** blocker
- **State:** absent
- **Owner:** `packages/dispatch/dispatch-orchestrator`
- **Epic:** EPIC-DISPATCH-04-governance
- **Evidence:** `orchestrator.ts:906-1213` (destructive-op execution path) and `:483-578` (`defaultToolCallExec`'s switch statement) show `fs.move`/`fs.delete`/`fs.scaffold` dispatch straight to `fsp.rename`/`fsp.rm`/`fsp.writeFile` with only a path-containment check (`resolveToolPath`) — no allow/deny/ask gate anywhere. The only rail is `dispatch-cli`'s `--dry-run` default at the CLI layer, not an in-orchestrator permission check.

### 14. Budget/spend caps enforced by default
- **Criticality:** blocker
- **State:** unwired
- **Owner:** `packages/agent/agent-plugin-budget`
- **Epic:** EPIC-DISPATCH-04-governance
- **Evidence:** Real, 1398-line enforcement plugin exists, but is loaded only via an external `agent-mcp.config.json` `plugins` array (`loader.ts:260-281`). `entrypoint/agent-mcp/src/config.ts:220-225` confirms `plugins.entries` defaults to `[]`, opt-in only via `ADHD_AGENT_PLUGINS`. The only reference to `@adhd/agent-plugin-budget` in `entrypoint/agent-mcp/src` is a test file (`__tests__/integration/live-budget.e2e.test.ts:65`) — zero production imports.

### 15. Shell hooks as enforcement (PreToolUse/PostToolUse equivalent)
- **Criticality:** important
- **State:** unwired
- **Owner:** `packages/agent/agent-engine-orchestrator/src/engine/hooks.ts`
- **Epic:** EPIC-DISPATCH-04-governance
- **Evidence:** The user runs 4 hooks today (`~/.claude/settings.json:19-89`: gitnexus enrichment, output caps, budget gate, anomaly miner). `hooks.ts:1-60` — `HookRegistry.register`/`emit`/`registerEnforcement`/`enforce` all take in-process TS function handlers only; no child-process/shell-spawn adapter exists anywhere in `agent-base-types` or `agent-engine-orchestrator`.

### 16. Live cost / progress visibility during a run
- **Criticality:** important
- **State:** absent
- **Owner:** `entrypoint/dispatch-cli`
- **Epic:** EPIC-DISPATCH-04-governance
- **Evidence:** Usage lands in `dispatch_log` only after a full cycle (`orchestrator.ts:1176-1198`); `bin/cli.ts`'s `printAndExit` dumps one JSON blob at the end. `grep -rn 'follow' entrypoint/dispatch-cli/src` returns zero hits for a flag (only a prose "followed" in an `api.ts` doc comment).

### 17. Streamed model output to the terminal
- **Criticality:** important
- **State:** partial
- **Owner:** substrate (`entrypoint/agent-mcp/src/streaming`, real SSE) + `entrypoint/dispatch-cli` (nothing)
- **Epic:** EPIC-DISPATCH-06-daily-driver-ux
- **Evidence:** `entrypoint/agent-mcp/src/streaming/{chat-gateway,event-bus,sse-server}.ts` exist and are wired to HITL — the substrate can genuinely stream. `agent-runner.ts:413-433`'s `poll()` returns only `{status, usage}` after polling to terminal state — dispatch never subscribes to the SSE stream.

### 18. Interactive REPL / mid-task steering
- **Criticality:** important
- **State:** absent
- **Owner:** `entrypoint/dispatch-cli`
- **Epic:** EPIC-DISPATCH-06-daily-driver-ux
- **Evidence:** `bin/cli.ts:60-144` registers exactly 7 non-interactive commands (validate/snapshot/optimize/eligible/status/run/calibrate), confirmed by full enumeration — none named `chat`/`continue`, no interactive loop.

### 19. dag.json authoring / scaffolding (no hand-written JSON)
- **Criticality:** blocker
- **State:** absent
- **Owner:** `packages/dispatch/dispatch-tools` (does not exist)
- **Epic:** EPIC-DISPATCH-05-work-authoring
- **Evidence:** `ls packages/dispatch/` (2026-08-12) confirms exactly 6 directories (`dispatch-base-spec`, `dispatch-base-types`, `dispatch-core-client`, `dispatch-core-optimizer`, `dispatch-orchestrator`, `dispatch-serializer-json`) — no `dispatch-tools`. `docs/plan/dispatch-completion`'s README (`:86-93`) and `SCOPE.md`/`PLAN_STATE_MACHINE_PROPOSAL.md` already scope this exact package as dod.11/P6, but it is unbuilt on disk.

### 20. Backlog as a work source for dispatch plans
- **Criticality:** important
- **State:** partial
- **Owner:** `entrypoint/backlog` + `docs/plan/backlog-interface-v2-dispatch`
- **Epic:** EPIC-DISPATCH-05-work-authoring
- **Evidence:** `docs/plan/backlog-interface-v2-dispatch` already designs backlog-as-work-orders — 45 work orders authored across 7 epics, zero claimed (per the plan-corpus audit's finding-2).

### 21. Cross-repo-key backlog dedupe for this repo
- **Criticality:** important
- **State:** absent
- **Owner:** `entrypoint/backlog`
- **Epic:** EPIC-DISPATCH-05-work-authoring
- **Evidence:** Re-verified live via `mcp__backlog__backlog_stats` 2026-08-12: `byRepo` still shows `PseudoSky/adhd:384`, `adhd:57` — the split persists, unfixed. Matches `git remote -v` origin (`github.com:PseudoSky/adhd.git`) as the canonical key; `adhd` holds legacy items predating the family-prefixed ID convention (e.g. `agent-mcp-001`, `BUG-016`, `TASK-001`). Backlog: `BUG-BACKLOG-REPO-SPLIT-001`, `DEBT-BACKLOG-REPO-MOVE-001` (the move-tool schema, re-checked this session, still has no `repo` field — confirmed via the live `mcp__backlog__backlog_update_item` schema fetched via ToolSearch: `patch={body,importedFrom,projectPath,tags,title}`, no `repo`).

### 22. Git-aware operations (diff review, commit, branch)
- **Criticality:** important
- **State:** absent
- **Owner:** `packages/dispatch/dispatch-base-spec` (`OperationAction` enum)
- **Epic:** EPIC-DISPATCH-01-capability-floor
- **Evidence:** `OperationAction` at `types.ts:18-37`, read in full — contains `fs.*`/`dag.*` members only, no `git.*` member of any kind.

### 23. Anthropic prompt caching (cache_control breakpoints)
- **Criticality:** important
- **State:** absent
- **Owner:** `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts`
- **Epic:** EPIC-DISPATCH-04-governance
- **Evidence:** `grep -rn 'cache_control' packages/agent/agent-engine-orchestrator/src` returns zero hits. `anthropic.ts:243-253` builds the stream call with no `cache_control` blocks on system/tools/messages; line 50's own comment acknowledges the resulting cost-undercounting. Usage is read back from the API response but caching is never requested.

### 24. Context-window compaction on long sessions
- **Criticality:** important
- **State:** present
- **Owner:** `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts`
- **Epic:** EPIC-DISPATCH-03-session-continuity
- **Evidence:** `decideCompaction`/`compactMessages` real, with a 0.75 trigger fraction and a cache-preserving stable head. Exercised only by a unit test (`__tests__/context-window.test.ts`) — `grep` across `dispatch-orchestrator/src` and `dispatch-cli/src` for `context-window|decideCompaction` returns zero real code-path hits (one doc-comment at `dispatch-cli/src/api.ts:62`). Never proven through an actual dispatch-driven long session.

### 25. Policy enforcement (recursion depth, tool-loop cap, delegation allowlist)
- **Criticality:** important
- **State:** present
- **Owner:** `packages/agent/agent-engine-orchestrator/src/engine/policy.ts`
- **Epic:** EPIC-DISPATCH-04-governance
- **Evidence:** `policy.ts:48-113` — `PolicyEngine.check()` throws `MAX_DEPTH_EXCEEDED`/`MAX_TOOL_LOOPS_EXCEEDED`/`DELEGATION_NOT_ALLOWED` on every request, enforced by default in the orchestrator's request path. The only dispatch-side test referencing "policy" (`dispatch-orchestrator/src/test/real-turn-telemetry.spec.ts:159-161,210`) stubs it as a no-op that always permits — never exercises the real engine through a dispatch-driven delegation chain.

### 26. Named subagent personas / delegation catalog
- **Criticality:** important
- **State:** partial
- **Owner:** `packages/agent/agent-store-prompts` + `agent_create`
- **Epic:** EPIC-DISPATCH-07-workflow-parity
- **Evidence:** `ls ~/.claude/agents` = 40 persona files, with no equivalent in dispatch. `agent-store-prompts/src/store/agent-store.ts` and `entrypoint/agent-mcp/src/index.ts` (`agent_create`/`agent_update` write path) both confirmed as the right home — both exist, but nothing populates from `~/.claude/agents`. `find entrypoint/dispatch-cli/src -iname '*agent*'` returned nothing; grep for import/persona terms across the store and server found zero real hits.

### 27. Packaged skills / repeatable workflow bundles
- **Criticality:** nice
- **State:** absent
- **Owner:** none
- **Epic:** EPIC-DISPATCH-07-workflow-parity
- **Evidence:** 21-22 skills installed in `~/.claude/skills` (count varies slightly by audit pass — 21 in the incumbent-bar audit, 22 in the workflow-parity epic's own `ls`), no skill-invocation concept anywhere in dispatch or agent-mcp. Full read of `MilestoneDag`, `dispatch-base-spec/src/lib/types.ts:501-528` — no `skill` field.

### 28. Persistent memory (MEMORY.md / memory-server) reachable from a dispatched agent
- **Criticality:** important
- **State:** partial
- **Owner:** reachable only via `mcpServers` federation, never wired by default
- **Epic:** EPIC-DISPATCH-07-workflow-parity
- **Evidence:** MEMORY.md is a load-bearing decision record (git-stash corruption, pnpm history, etc.). `McpClientRegistry` (row 5) genuinely supports federating a memory server in, but `grep 'mcpServers'` across `packages/agent` + `entrypoint/agent-mcp` found only the generic plumbing — no seed defaults wiring memory-server into agents created for dispatch.

### 29. Web search / fetch from a dispatched agent
- **Criticality:** important
- **State:** absent (federatable via mcpServers)
- **Owner:** none in-box
- **Epic:** EPIC-DISPATCH-07-workflow-parity
- **Evidence:** `packages/agent/agent-core-provider/src/runtime/emit-tools.ts:1-90` — a server-side `web_search` emitter exists, but its own header comment states wiring into the live provider is unbuilt ("agent-mcp-refactor's job (plan 6)"). Confirmed via `grep -rn 'emit-tools|emitTools|EmittedServerSideTool'` across `entrypoint/agent-mcp/src` and `agent-engine-orchestrator/src` (excl. tests/dist): zero hits. Genuinely unwired, not just undocumented. Also absent from agent-mcp's 16-tool MCP surface.

### 30. apigen-generated dispatch CLI usable (all 7 commands)
- **Criticality:** nice
- **State:** partial
- **Owner:** `packages/apigen/apigen-core` + `apigen-base-logical`
- **Epic:** EPIC-DISPATCH-06-daily-driver-ux
- **Evidence:** `entrypoint/dispatch-cli/bin/cli.ts:11-30` documents the live `$ref` bug verbatim: `'[apigen-logical] $ref "#/definitions/boolean" cannot be resolved in run-mode without a descriptor root'`. Only `eligible`/`status` work through the generated router; the other 5 commands fail. Root cause traced to `apigen-base-logical/src/lib/runmode.ts`'s `buildCtx()` `resolve()` permanent-throw stub. A related-but-narrower fix (`BUG-APIGEN-CORE-001`, marked FIXED 2026-07-06 for zod-contamination) predates `cli.ts`'s authorship (2026-07-15) and did not close this gap — `cli.ts` still documents the error as live after that fix landed.

### 31. Clean-room external-consumer e2e verification of published packages
- **Criticality:** blocker
- **State:** absent
- **Owner:** `tools/nx-plugins` release pipeline + CI
- **Epic:** EPIC-DISPATCH-02-substrate-trust
- **Evidence:** Search for a "packed-consumer"/"clean-room" harness finds only the existing liveness-only `clean-room-smoke.mjs`/`.spec.mjs` (`tools/nx-plugins/build/executors/smoke-test/`) — no functional packed-tarball consumer gate exists. `.github/workflows/pull-request.yml:119-140` read directly, confirms the publish step still runs bare `nx affected -t build/version/publish` with no `check-release-ranges` or `clean-room-smoke` step (`grep` for both: 0 matches). Backlog: `TASK-001` (filed under repo key `adhd`, not `PseudoSky/adhd` — this is deliberate per the item's own human-ID-collision warning, since a different `TASK-001` exists under the other key).

### 32. Ephemeral-task durability across agent-mcp restart
- **Criticality:** important
- **State:** absent
- **Owner:** `packages/agent/agent-engine-orchestrator` + `entrypoint/agent-mcp`
- **Epic:** EPIC-DISPATCH-03-session-continuity
- **Evidence:** `BUG-AGENTMCP-EPHEMERAL-CONTEXT-LOST-001` (pre-existing, OPEN) documents "Ephemeral task context lost on server restart; create a new task," surfaced only lazily on next poll. Every dispatch fires an ephemeral task (row 10), so this failure mode is the default for dispatch, not an edge case.

---

## Repo-key note (applies to every citation above)

All backlog IDs cited in this matrix live under repo key `PseudoSky/adhd` (the canonical key, matching `git remote -v` origin `github.com:PseudoSky/adhd.git`) **except `TASK-001`**, which is deliberately filed/read under the legacy `adhd` key — querying it under `PseudoSky/adhd` silently returns a different, unrelated item with the same human-readable ID. This split is itself tracked as `BUG-BACKLOG-REPO-SPLIT-001` (CRITICAL) and `DEBT-BACKLOG-REPO-MOVE-001` (CRITICAL, no tool yet exists to move an item's `repo` field). Any future query against this program's backlog items must account for the split explicitly.
