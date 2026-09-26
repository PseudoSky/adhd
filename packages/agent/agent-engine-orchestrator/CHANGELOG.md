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