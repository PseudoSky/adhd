## 2.3.4 (2026-10-06)

### 🚀 Features

- **agent-engine-orchestrator:** enforce the resolved native-tooling permission gate (NAT-TOOL-6) ([0103dc2f](https://github.com/PseudoSky/adhd/commit/0103dc2f))
- **agent-engine-orchestrator:** thread cwd + subprocessEnv into MCP clients (ADR-0008 D9 / NAT-TOOL-3) ([919d6e86](https://github.com/PseudoSky/adhd/commit/919d6e86))
- **agent-base-types:** nativeTooling typed config + stdio cwd (ADR-0008 NAT-TOOL-1) ([a2840f17](https://github.com/PseudoSky/adhd/commit/a2840f17))
- **agent-engine-orchestrator,agent-mcp:** gate agent systemPrompt behind explicit opt-in ([4a6ae079](https://github.com/PseudoSky/adhd/commit/4a6ae079))
- **agent-engine-orchestrator:** provider-native web_search/web_fetch in the default toolset (1abd2d84) ([e95bc2df](https://github.com/PseudoSky/adhd/commit/e95bc2df))
- **agent-engine-orchestrator:** native tasks_batch bulk/parallel dispatch primitive (05cc1db4) ([182d741c](https://github.com/PseudoSky/adhd/commit/182d741c))
- **agent-engine-orchestrator,agent-mcp:** add agent_verify_mcp handshake check ([88171d7c](https://github.com/PseudoSky/adhd/commit/88171d7c))
- **agent-engine-orchestrator,agent-mcp:** surface open sessions on agent_update ([492092a2](https://github.com/PseudoSky/adhd/commit/492092a2))
- **agent-engine-orchestrator:** bound and filter task_list/result output ([d237241f](https://github.com/PseudoSky/adhd/commit/d237241f))
- **agent-mcp:** load budget plugin by default with conservative cap (5339c2e5) ([3ccb0e86](https://github.com/PseudoSky/adhd/commit/3ccb0e86))

### 🩹 Fixes

- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))
- **agent-engine-orchestrator:** route an escalated ask to the parent task (a0c0a826) ([85fa0dba](https://github.com/PseudoSky/adhd/commit/85fa0dba))
- **agent-engine-orchestrator:** require explicit approval for a permission ask (FIX 5) ([890076cb](https://github.com/PseudoSky/adhd/commit/890076cb))
- **agent-engine-orchestrator:** unify HITL gate on effectiveHitl; fail synchronous asks closed ([17f6dfb7](https://github.com/PseudoSky/adhd/commit/17f6dfb7))
- **agent-mcp,agent-store-runtime:** collapse duplicate vite plugins keys; sweep all configs (50b77657) ([f2e8ceba](https://github.com/PseudoSky/adhd/commit/f2e8ceba))
- **agent-mcp:** resolve default budget plugin from agent-mcp's own module base (cc636860) ([dd0ed875](https://github.com/PseudoSky/adhd/commit/dd0ed875))
- **agent-engine-orchestrator:** collapse duplicate vite plugins key (50b77657) ([6b6458d2](https://github.com/PseudoSky/adhd/commit/6b6458d2))
- **agent-engine-orchestrator:** compile the spec corpus with a typecheck-spec ratchet ([4c254146](https://github.com/PseudoSky/adhd/commit/4c254146))
- **agent-engine-orchestrator:** enforce task depends_on gating before dispatch (ac115447) ([2f5a556a](https://github.com/PseudoSky/adhd/commit/2f5a556a))
- **agent-engine-orchestrator:** resolve the default budget plugin from the engine (dfb03557) ([976e4a2a](https://github.com/PseudoSky/adhd/commit/976e4a2a))
- **agent-engine-orchestrator:** type projected taskList/resultTool as ProjectedTask ([6ee04cea](https://github.com/PseudoSky/adhd/commit/6ee04cea))
- **agent-engine-orchestrator,agent-mcp:** wire full/fields opt-in into agent_update response ([d0d26495](https://github.com/PseudoSky/adhd/commit/d0d26495))
- **agent-engine-orchestrator:** tri-state status for agent_verify_mcp results ([30b04c74](https://github.com/PseudoSky/adhd/commit/30b04c74))
- **agent-engine-orchestrator:** route provider SDK client timeout through the raised default (36a73117) ([f6213b58](https://github.com/PseudoSky/adhd/commit/f6213b58))
- **dispatch-orchestrator:** surface agent-mcp policy violations through dispatch_log (4e829a08) ([b6884f67](https://github.com/PseudoSky/adhd/commit/b6884f67))
- **agent-engine-orchestrator:** raise default provider timeout 60s->300s (36a73117) ([08544fae](https://github.com/PseudoSky/adhd/commit/08544fae))
- **agent-engine-orchestrator:** clamp claudecli env bleed + group-aware teardown (322a1efb) ([37ce3c0d](https://github.com/PseudoSky/adhd/commit/37ce3c0d))
- **agent-engine-orchestrator,agent-mcp:** add delete/rename semantics to mcpServers patch ([37ce3650](https://github.com/PseudoSky/adhd/commit/37ce3650))

### ❤️ Thank You

- pseudosky

## 2.3.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 2.3.1 (2026-09-24)


### 🩹 Fixes

- **nx:** drop self-referential scripts.build wrappers to restore build cache


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 2.3.0 (2026-08-11)


### 🚀 Features

- **agent-plugin-budget:** rename tokens cap to context with peak semantics + contextWindowFraction (Packet B, BUG-AGENTMCP-009)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — typed TestDb access + hitl resolver-before-status ordering

- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — close HITL error-path races (emit leak + abort-race rejection)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 2.1.7 (2026-07-26)

Ships proper usage accounting and budget enforcement, plus the claudecli provider usage fix (e660126b) — required by `@adhd/agent-mcp@2.1.5` (BUG-MCP-PLUGIN-CONFIG-001). Republished as part of unbreaking the `@adhd/agent-mcp` install chain (BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001) after the prior `agent-engine-orchestrator@2.1.6` was published broken (empty tarball, via the retired `nx release publish`) by a separate, since-terminated agent session.

## 2.1.6 (2026-07-25)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## 2.1.5 (2026-07-24)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## 2.1.4 (2026-07-24)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## 2.1.3 (2026-07-23)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.