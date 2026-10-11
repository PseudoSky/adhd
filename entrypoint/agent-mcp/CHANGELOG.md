## Unreleased

### 🩹 Fixes

- **agent-mcp:** the CRLF-preserving eol hook now rewrites via temp-file + rename preserving file mode, skips with a warning when a competing write lands mid-rewrite, bounds its pending-call map (1024 entries / 10 min TTL), and never reads files over 8 MiB; e2e covers an `isError:true` MCP result through the real engine (19354419 AC1 AC2 AC3 AC4 AC5)
- **agent-mcp:** `AGENT_NOT_FOUND` now lists the registered agent names (sorted, capped at 20 with "+N more", names only — no system prompts), and the `agent` tool description says how to discover valid names (1b947d91 AC1 AC2 AC3)

## 2.3.11 (2026-10-10)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.3.10 (2026-10-10)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.3.9 (2026-10-10)

### 🚀 Features

- **agent-mcp:** optional spill-to-file for oversize tool results, read-allowed in the srt sandbox only when enabled (3ad735bb BK9, plan 9ed453c1) ([c599fe1f](https://github.com/PseudoSky/adhd/commit/c599fe1f))
- **agent-engine-orchestrator:** resolve claudecli model aliases and price per resolved model (79aebb26 BK8) ([145fdfc9](https://github.com/PseudoSky/adhd/commit/145fdfc9))
- **agent-engine-orchestrator:** cap model-visible tool results with head+tail truncation (3ad735bb) ([c328b3ff](https://github.com/PseudoSky/adhd/commit/c328b3ff))
- **agent-mcp:** pricing + server-lifecycle ops logs, pricing feed through the wire fetch seam (c536ce29 TRC-AC7 TRC-AC10 TRC-AC18 P2-AC-C) ([d745614c](https://github.com/PseudoSky/adhd/commit/d745614c))
- **agent-engine-orchestrator:** route provider and MCP-client egress through EngineConfig.wire; hooks on task providers; agent-mcp WireSeams (c536ce29 TRC-AC2 AC3 AC5 AC6 P1-AC-A) ([4fd865e7](https://github.com/PseudoSky/adhd/commit/4fd865e7))
- **agent-mcp:** inbound raw api capture for MCP tools and HTTP routes (c536ce29 TRC-AC23 AC24 W3-AC-A) ([aa105b57](https://github.com/PseudoSky/adhd/commit/aa105b57))
- **agent-mcp:** traced fetch/spawn/MCP-transport wire wrappers and EngineConfig.wire seams (c536ce29 TRC-AC2 AC3 AC4 AC5w AC6w AC9) ([5790a393](https://github.com/PseudoSky/adhd/commit/5790a393))
- **agent-mcp:** api+ops log channels from environment roots, pino into ops channel, core-ops events (c536ce29 TRC-AC10 AC11 AC15) ([efaddc9e](https://github.com/PseudoSky/adhd/commit/efaddc9e))
- **agent-mcp:** logs/temp dirs shared-global under ~/.adhd, logging.* config keys, tracing logDir defaults to <logs>/trace (c536ce29) ([0eaf255e](https://github.com/PseudoSky/adhd/commit/0eaf255e))
- **agent-mcp:** daily OpenRouter price pull, scheduler, pricing_refresh and pricing_history tools (37f6c511, 1f1c8598) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **agent-store-runtime:** price history tables and cost provenance columns (1f1c8598 37f6c511) ([bc340a5b](https://github.com/PseudoSky/adhd/commit/bc340a5b))
- **agent-mcp:** default srt denyRead of credential paths, unioned never clobbering (faa8064b S4, SHELL-AC7) ([fcf5bc51](https://github.com/PseudoSky/adhd/commit/fcf5bc51))
- **agent-mcp:** serve/serve-status/serve-stop nx targets - live-reload HTTP dev server that never builds ([be0e19bd](https://github.com/PseudoSky/adhd/commit/be0e19bd))
- **agent-mcp:** default-load agent-plugin-tracing with typed tracing config, reuse existing telemetry provider, audit script + docs (0f760dcd, 5dff26e6) ([0891a3bc](https://github.com/PseudoSky/adhd/commit/0891a3bc))
- **agent-engine-orchestrator:** ask escalation climbs transitively to the nearest interactive ancestor, root-terminal deny (fc466f0b) ([6bd3e4f6](https://github.com/PseudoSky/adhd/commit/6bd3e4f6))
- **dispatch-orchestrator:** drop implicit claudecli agent default (fail closed); document session_update + provider selection (5ad2cf37 D-G(2)) ([5667dff8](https://github.com/PseudoSky/adhd/commit/5667dff8))
- **agent-mcp:** session_update tool, host default provider tier, registry seeding + provider-selection e2e (5ad2cf37 D-G(2)) ([ef9f72e6](https://github.com/PseudoSky/adhd/commit/ef9f72e6))
- **agent:** pass the adopted shell server's ALLOW_PATTERNS through ([f74e9b05](https://github.com/PseudoSky/adhd/commit/f74e9b05))
- **agent-mcp,agent-core-native-tooling:** portable multi-root fs + caller-supplied cwd + global allowed-root map (ADR-0008 D4/D7/D8) ([99f43c07](https://github.com/PseudoSky/adhd/commit/99f43c07))
- **agent-mcp:** wire the native-tooling permission gate + prove it end-to-end (NAT-TOOL-6) ([ff9368a1](https://github.com/PseudoSky/adhd/commit/ff9368a1))
- **agent-mcp:** consume the native-tooling config surface (NAT-TOOL-7) ([36db3df0](https://github.com/PseudoSky/adhd/commit/36db3df0))
- **agent-mcp:** single task-time resolution for nativeTooling, merge precedence (NAT-TOOL-4) ([740f8325](https://github.com/PseudoSky/adhd/commit/740f8325))
- **agent-mcp:** resolve native tooling at task time (ADR-0008 NAT-TOOL-4) ([27f23441](https://github.com/PseudoSky/adhd/commit/27f23441))
- **agent-core-native-tooling:** adopt fs + tumf shell + srt; retire authored shell (NAT-TOOL-8) ([db17316f](https://github.com/PseudoSky/adhd/commit/db17316f))
- **agent-engine-orchestrator,agent-mcp:** gate agent systemPrompt behind explicit opt-in ([4a6ae079](https://github.com/PseudoSky/adhd/commit/4a6ae079))
- **agent-engine-orchestrator:** provider-native web_search/web_fetch in the default toolset (1abd2d84) ([e95bc2df](https://github.com/PseudoSky/adhd/commit/e95bc2df))
- **agent-mcp:** default-wire filesystem + shell MCP servers for new agents (97acef07) ([ecd0f138](https://github.com/PseudoSky/adhd/commit/ecd0f138))
- **agent-engine-orchestrator:** native tasks_batch bulk/parallel dispatch primitive (05cc1db4) ([182d741c](https://github.com/PseudoSky/adhd/commit/182d741c))
- **agent-engine-orchestrator,agent-mcp:** add agent_verify_mcp handshake check ([88171d7c](https://github.com/PseudoSky/adhd/commit/88171d7c))
- **agent-engine-orchestrator,agent-mcp:** surface open sessions on agent_update ([492092a2](https://github.com/PseudoSky/adhd/commit/492092a2))
- **agent-mcp:** load budget plugin by default with conservative cap (5339c2e5) ([3ccb0e86](https://github.com/PseudoSky/adhd/commit/3ccb0e86))
- **agent-mcp:** add SSE follow renderer + agent-mcp-follow bin ([8a8c8c85](https://github.com/PseudoSky/adhd/commit/8a8c8c85))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([b2022986](https://github.com/PseudoSky/adhd/commit/b2022986))
- **agent-mcp:** add agent-mcp-install bin to register MCP server into host configs (BUG-AGENTMCP-006) ([7a0f93de](https://github.com/PseudoSky/adhd/commit/7a0f93de))
- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect ([b701f12f](https://github.com/PseudoSky/adhd/commit/b701f12f))
- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2) ([b777b50b](https://github.com/PseudoSky/adhd/commit/b777b50b))
- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes ([91621210](https://github.com/PseudoSky/adhd/commit/91621210))

### 🩹 Fixes

- **agent-engine-orchestrator:** bridged claudecli calls get events, coercion and a per-call timeout; fail redispatch on a missing cwd; skip home file in store-path warning (9ed453c1 BLIND F4 F6 F8 F9) ([7adb975e](https://github.com/PseudoSky/adhd/commit/7adb975e))
- **agent-engine-orchestrator:** spawn claudecli in the task dispatching cwd and persist it for redispatch (9ed453c1 CWD) ([d479f8c8](https://github.com/PseudoSky/adhd/commit/d479f8c8))
- **agent-mcp:** allowlist the srt spill read dir; give e2e/unit hooks explicit budgets (9ed453c1 HARD-H1/H2/H3) ([4cff3032](https://github.com/PseudoSky/adhd/commit/4cff3032))
- **agent-mcp:** e2e lane builds default plugins; loud prerequisite check; default-plugin load failures surface to stderr + ops (c536ce29 E2E-PREREQ, 9ed453c1) ([41171795](https://github.com/PseudoSky/adhd/commit/41171795))
- **agent-mcp:** narrow the shell sandbox backlog write allow to production/data and harden the allowlist, policy file and sidecars (515a2b50 SEC-F1..F8) ([d5723f46](https://github.com/PseudoSky/adhd/commit/d5723f46))
- **agent-mcp:** allow ~/.adhd/backlog in the default srt shell sandbox via agent.shell.sandbox.extraAllowWrite (515a2b50) ([45539f8d](https://github.com/PseudoSky/adhd/commit/45539f8d))
- **agent-engine-orchestrator:** coerce stringified array/object tool arguments per declared schema (114e014c) ([36e7160d](https://github.com/PseudoSky/adhd/commit/36e7160d))
- **agent-mcp:** production store by default, never cwd-dependent; startup store line (de046157 BK6) ([677d5e58](https://github.com/PseudoSky/adhd/commit/677d5e58))
- **agent-mcp:** make S8B-AC2 tail DB path test hermetic and assert the resolved-absolute contract (c536ce29) ([75c0869c](https://github.com/PseudoSky/adhd/commit/75c0869c))
- **agent-plugin-tracing:** consume published @adhd/sox-telemetry ^0.4.3, drop vendored tarball and release block (0f3667fd, c536ce29) ([1c21a387](https://github.com/PseudoSky/adhd/commit/1c21a387))
- **agent-mcp:** blind-review findings M1-M3, L1-L10 on the tracing delta (c536ce29) ([0f88a9c5](https://github.com/PseudoSky/adhd/commit/0f88a9c5))
- **agent-core-provider:** price cache writes by TTL tier so 1h writes use the 1h rate (b726a987) ([684c60ca](https://github.com/PseudoSky/adhd/commit/684c60ca))
- **agent-mcp:** consumer-install e2e pins vendored sox-telemetry via npm overrides (0f3667fd BRIDGE-AC1, c536ce29) ([35ccd159](https://github.com/PseudoSky/adhd/commit/35ccd159))
- **agent-mcp:** host injects namespaced tempDir, claudecli drops os.tmpdir fallback, stop/shutdown pair, component on every ops record (c536ce29 S8B-AC1 F1-AC-A F1-AC-B F1-AC-C TRC-AC18, 03be90c3) ([ecfdf523](https://github.com/PseudoSky/adhd/commit/ecfdf523))
- **agent-mcp:** pin tracing-e2e audit run to the spans its scenario produces; revert ineffective vendor files entry (c536ce29 P2-AC-A, 0f3667fd unresolved: npm cannot resolve file: tarball dep of a packed tarball) ([41904d58](https://github.com/PseudoSky/adhd/commit/41904d58))
- **agent-mcp:** route tail DB path, srt run-policy and claudecli scratch through the namespaced environment roots (c536ce29 S8B-AC1 S8B-AC2, 03be90c3) ([d671a613](https://github.com/PseudoSky/adhd/commit/d671a613))
- **agent-mcp:** accepting pricing_refresh bypasses the forced-pull floor (9ae6927d AC4) ([99747cda](https://github.com/PseudoSky/adhd/commit/99747cda))
- **agent-mcp:** scheduler backoff, 8 MiB body cap, typed db, sub-agent pricing_refresh without accept, forced floor (37f6c511, 1f1c8598, 9ae6927d) ([07f7ebb8](https://github.com/PseudoSky/adhd/commit/07f7ebb8))
- **agent-mcp:** bind loopback 127.0.0.1 by default; apigen hosts and generated servers too (5989ed90) ([c079e826](https://github.com/PseudoSky/adhd/commit/c079e826))
- **agent-mcp:** process env beats .env files in loadEnvHierarchy (76950870) ([e34fb60f](https://github.com/PseudoSky/adhd/commit/e34fb60f))
- **agent-mcp:** http transport binds loopback by default, serves multiple MCP sessions, SSE logs bound port (5989ed90 S8/S9/S11) ([d982dc38](https://github.com/PseudoSky/adhd/commit/d982dc38))
- **agent-mcp:** --help/--version/unknown-flag answered before any DB-opening import; prepare only sets core.hooksPath in the main checkout (3d6860dd, f2b26b12) ([9b881398](https://github.com/PseudoSky/adhd/commit/9b881398))
- **agent-engine-orchestrator:** agent_create/agent_update input accepts legacy apiKeyEnv/authTokenEnv (mapped to env.secret); document PF-1 provider fields and strict input in agent-mcp (2eddcf91, 3864449b) ([3848205c](https://github.com/PseudoSky/adhd/commit/3848205c))
- **agent-mcp:** agent_update is a no-op (no version bump/write) when the patch changes nothing (F-PERF-3) ([beb25964](https://github.com/PseudoSky/adhd/commit/beb25964))
- **githooks:** pre-push runs test only, e2e stays CI-only; machine-check NAT_TOOL_LIVE gate tables (8963c3cb, 90d07610) ([b3106036](https://github.com/PseudoSky/adhd/commit/b3106036))
- **agent-engine-orchestrator:** reconstruct rootTaskId/callingAgentName on re-dispatch (0d77376f) ([90df4a43](https://github.com/PseudoSky/adhd/commit/90df4a43))
- **agent-mcp:** silence dotenv banner on stdio stdout (a0806529) ([eae6661c](https://github.com/PseudoSky/adhd/commit/eae6661c))
- **agent-mcp:** assert pinned node fs launch + pinned shell, drop npm registry from srt allowlist, connectTimeoutMs type, docs (c9f0a791) ([b9ab73bc](https://github.com/PseudoSky/adhd/commit/b9ab73bc))
- **agent-mcp:** move gitnexus-singleton contract out of gitnexus-owned skill dir (2cd99264) ([ed73dec1](https://github.com/PseudoSky/adhd/commit/ed73dec1))
- **agent-mcp:** union caller cwd into srt allowWrite when fs.root is explicit; add 48dc agent-portability e2e (7e854708, 33713d33) ([5fee7923](https://github.com/PseudoSky/adhd/commit/5fee7923))
- **agent-mcp:** hoist srt allowWrite union to host call sites; warn host-fallback once per process ([8923c7d4](https://github.com/PseudoSky/adhd/commit/8923c7d4))
- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))
- **agent-engine-orchestrator:** route an escalated ask to the parent task (a0c0a826) ([85fa0dba](https://github.com/PseudoSky/adhd/commit/85fa0dba))
- **agent-engine-orchestrator:** require explicit approval for a permission ask (FIX 5) ([890076cb](https://github.com/PseudoSky/adhd/commit/890076cb))
- **agent-engine-orchestrator:** unify HITL gate on effectiveHitl; fail synchronous asks closed ([17f6dfb7](https://github.com/PseudoSky/adhd/commit/17f6dfb7))
- **agent-mcp:** retain legacy mcp-shell security.yaml; restore f141baad guard (NAT-TOOL-4) ([102414c6](https://github.com/PseudoSky/adhd/commit/102414c6))
- **agent-mcp:** ship the missing calc-server.mjs live fixture and unignore it (305a63d4) ([52318772](https://github.com/PseudoSky/adhd/commit/52318772))
- **agent-mcp,agent-store-runtime:** collapse duplicate vite plugins keys; sweep all configs (50b77657) ([f2e8ceba](https://github.com/PseudoSky/adhd/commit/f2e8ceba))
- **dispatch-cli:** correct same stale e2e filename in test-target comment (d965f490) ([0812e1ba](https://github.com/PseudoSky/adhd/commit/0812e1ba))
- **agent-mcp:** ADHD_AGENT_SKIP_LEGACY_MIGRATION flag for hermetic boots (af567fb8) ([53418eb7](https://github.com/PseudoSky/adhd/commit/53418eb7))
- **agent-mcp:** resolve default budget plugin from agent-mcp's own module base (cc636860) ([dd0ed875](https://github.com/PseudoSky/adhd/commit/dd0ed875))
- **agent-mcp:** correct stale e2e filename in dist-manifest comment (d965f490) ([157cbdff](https://github.com/PseudoSky/adhd/commit/157cbdff))
- **agent-mcp,dispatch-cli:** materialize registry-family drizzle for the spawned host ([b1bb718b](https://github.com/PseudoSky/adhd/commit/b1bb718b))
- **agent-mcp:** reconcile in-place task_usage updates; refuse a false-success legacy seed ([d78aaf2f](https://github.com/PseudoSky/adhd/commit/d78aaf2f))
- **agent-engine-orchestrator,agent-mcp:** wire full/fields opt-in into agent_update response ([d0d26495](https://github.com/PseudoSky/adhd/commit/d0d26495))
- **agent-engine-orchestrator:** tri-state status for agent_verify_mcp results ([30b04c74](https://github.com/PseudoSky/adhd/commit/30b04c74))
- **agent-mcp:** spawn e2e servers with an isolated cwd so a repo .env cannot redirect the store ([f2c736ea](https://github.com/PseudoSky/adhd/commit/f2c736ea))
- **agent-mcp:** budget default caps resolve to global scope (move scope into defaults) ([6f30eb40](https://github.com/PseudoSky/adhd/commit/6f30eb40))
- **agent-mcp:** delta-scope legacy catch-up so canonical post-seed writes survive (80b61a7d) ([ea3923db](https://github.com/PseudoSky/adhd/commit/ea3923db))
- **agent-mcp:** repoint .mcp.json operational DB to canonical + migration catch-up (7acc68c1) ([20f541cc](https://github.com/PseudoSky/adhd/commit/20f541cc))
- **agent-mcp:** dedupe Claude MCP registration + fold args into signature (025a2a5e, 1034c8a8) ([3fcf997e](https://github.com/PseudoSky/adhd/commit/3fcf997e))
- **agent-mcp:** correct provider-call-audit source paths (c00ad483) ([7060faa4](https://github.com/PseudoSky/adhd/commit/7060faa4))
- **agent-mcp:** drop unused eslint-disable directives (3ac2372b) ([2a6dc470](https://github.com/PseudoSky/adhd/commit/2a6dc470))
- **agent-mcp:** resolve provider secrets via shell/.env cascade, not .mcp.json interpolation (307a36c1) ([e175c2dd](https://github.com/PseudoSky/adhd/commit/e175c2dd))
- **agent-mcp:** forward provider secrets + guard empty-value shadowing (307a36c1) ([d7192e04](https://github.com/PseudoSky/adhd/commit/d7192e04))
- **agent-mcp:** harden agent-mcp-follow against false success and bad input ([5c1aabd3](https://github.com/PseudoSky/adhd/commit/5c1aabd3))
- **agent-core-env,agent-mcp:** BEGIN IMMEDIATE + bounded BUSY retry on AgentStore read-modify-write ([d9fddae5](https://github.com/PseudoSky/adhd/commit/d9fddae5))
- **agent-mcp:** reconcile duplicate opencode agent-mcp registrations on install ([764f5142](https://github.com/PseudoSky/adhd/commit/764f5142))
- **agent-core-env,agent-mcp:** make the SQLite busy_timeout locking contract explicit ([c492feb8](https://github.com/PseudoSky/adhd/commit/c492feb8))
- **agent-engine-orchestrator,agent-mcp:** add delete/rename semantics to mcpServers patch ([37ce3650](https://github.com/PseudoSky/adhd/commit/37ce3650))
- **test:** make the full affected gate green (3 latent test-hermeticity fixes) ([2e9146f0](https://github.com/PseudoSky/adhd/commit/2e9146f0))
- **nx:** restore main's load-bearing test.dependsOn the remodel silently dropped ([4e1b9902](https://github.com/PseudoSky/adhd/commit/4e1b9902))
- **vite:** restore import.meta.url in CJS output under vite 8 ([9690844d](https://github.com/PseudoSky/adhd/commit/9690844d))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([4ccdb53e](https://github.com/PseudoSky/adhd/commit/4ccdb53e))
- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes) ([8698ee5f](https://github.com/PseudoSky/adhd/commit/8698ee5f))
- **agent-mcp:** reject bare trailing --scope instead of silently installing to all hosts (DEBT-AGENTMCP-INSTALL-HOST-DEFAULT-001 scope mirror) ([da55f0cd](https://github.com/PseudoSky/adhd/commit/da55f0cd))
- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — typed TestDb access + hitl resolver-before-status ordering ([8ca684a5](https://github.com/PseudoSky/adhd/commit/8ca684a5))
- **backlog:** DEBT-AGENTMCP-MIGRATION-PINNED-MARKER-001 — defer migration when operational DB is pinned to the flat legacy path ([0b600b5a](https://github.com/PseudoSky/adhd/commit/0b600b5a))
- **agent-mcp:** reject bare trailing --host instead of installing to all hosts (DEBT-AGENTMCP-INSTALL-HOST-DEFAULT-001) ([05166bdc](https://github.com/PseudoSky/adhd/commit/05166bdc))
- **agent-mcp:** make test 4 'never in repo tree' assertion fixture-owned ([4b0fb06e](https://github.com/PseudoSky/adhd/commit/4b0fb06e))
- **agent-mcp:** make config.scope-resolution.test.ts immune to ambient ADHD_AGENT_DATABASE_PATH from repo-root .env ([73807cdb](https://github.com/PseudoSky/adhd/commit/73807cdb))
- **agent-mcp:** scope-forced operational DB path + one-time flat→namespaced legacy migration (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001) ([c3a29f48](https://github.com/PseudoSky/adhd/commit/c3a29f48))
- **agent-mcp:** harden BUG-011 isMainModule guard — realpath both sides + real npm-shape teeth test ([32c35a86](https://github.com/PseudoSky/adhd/commit/32c35a86))
- **agent-mcp:** pin operational data dir scope to global (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001) ([d9152a70](https://github.com/PseudoSky/adhd/commit/d9152a70))
- **build:** route ESM packages' test target through dist-manifest + fail loud on type divergence (BUG-020) ([3aa62afd](https://github.com/PseudoSky/adhd/commit/3aa62afd))
- **agent-mcp:** assert a DELTA on REPO_ROOT/data, not an absolute — unblocks 2.2.2 publish ([abfdb0bd](https://github.com/PseudoSky/adhd/commit/abfdb0bd))
- **apigen-cli:** restore 2768 files mass-deleted by 6b36a38a (BUG-APIGEN-052) ([8202f672](https://github.com/PseudoSky/adhd/commit/8202f672))
- **agent-mcp:** eliminate double-import flakiness in real-environment.e2e.test.ts ([33c46ece](https://github.com/PseudoSky/adhd/commit/33c46ece))
- **agent-mcp:** run main() under symlinked launch — BUG-011 (npx/.bin/pnpm no-op) ([a4211e80](https://github.com/PseudoSky/adhd/commit/a4211e80))
- **agent-mcp:** restore provider credential resolution broken by env refactor (BUG-MCP-CREDENTIALS-001) ([882cb48c](https://github.com/PseudoSky/adhd/commit/882cb48c))
- **release:** finish agent-mcp usage-accounting release + fix two nx-build publish/version bugs ([114587f1](https://github.com/PseudoSky/adhd/commit/114587f1))
- **agent-mcp:** bump orchestrator 2.1.6 + agent-mcp 2.1.5, add missing budget-plugin dep ([6b61dcd2](https://github.com/PseudoSky/adhd/commit/6b61dcd2))
- **agent-mcp:** eliminate SSE-port contention across concurrent stdio instances ([2462ee6a](https://github.com/PseudoSky/adhd/commit/2462ee6a))
- **agent-mcp:** create + migrate registry DB on fresh machines instead of crashing SQLITE_CANTOPEN ([ddf25e90](https://github.com/PseudoSky/adhd/commit/ddf25e90))
- **agent-mcp:** agent-mcp-tail no longer fans per-task usage across every event (BUG-AGENTMCP-006) ([b1c2dc7c](https://github.com/PseudoSky/adhd/commit/b1c2dc7c))
- **agent-mcp:** 2.1.1 — ship drizzle migrations + pin external deps (2.1.0 was broken) ([e108083a](https://github.com/PseudoSky/adhd/commit/e108083a))
- **agent-mcp:** publish from dist — add packageRoot config, narrow asset glob (drops stray dist project.json), add publishConfig ([8e32fa8a](https://github.com/PseudoSky/adhd/commit/8e32fa8a))
- **agent-mcp:** cache-preserving context mgmt, provider-neutral token accounting, refactor-parity fixes; prep 2.1.0 family release ([29ab8497](https://github.com/PseudoSky/adhd/commit/29ab8497))
- move dispatch-cli to entrypoint, fix build infrastructure ([504d3b74](https://github.com/PseudoSky/adhd/commit/504d3b74))

### 🔥 Performance

- **agent-engine-orchestrator:** lean per-turn context for dispatched agents — compact tool schemas, cap claudecli bridge results, 6000-char default cap, --setting-sources project (9ed453c1 CTX) ([82727867](https://github.com/PseudoSky/adhd/commit/82727867))

### ❤️ Thank You

- parity-harness-self-test
- pseudosky

## 2.3.8 (2026-10-09)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## Unreleased

### 🚀 Features

- **Optional spill-to-file for oversize tool results (off by default).** `ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED=true` (config key `agent.toolResult.spill.enabled`) writes a result the cap would truncate to `<temp>/tool-results/<taskId>/<callId>.txt` (`0600` file, `0700` dirs, `O_EXCL`, symlinks never followed, task dirs swept after `agent.toolResult.spill.ttlHours`, default 24) and shows the model a stub with the path, size and a 2000-char preview, like the `claude` CLI does. An unwritable dir falls back to the head+tail cap; a relative or invalid `agent.toolResult.spill.dir` fails startup. The per-run `srt` policy read-allows the spill directory only while spill is enabled and never write-allows it. `TOOL_RESULT` events gain `spilled` and `spill_path`. See `docs/logging.md`. (3ad735bb)
- **`task_usage` records the resolved model.** For `claudecli` agents `model` is the concrete id the CLI reports (`--model haiku` -> `claude-haiku-5-5`), `requested_model` keeps the configured alias, and cost is priced against the resolved id (`claude-haiku-5-5` is ~10x cheaper than `claude-haiku-4-5`). New columns `requested_model`, `cli_reported_cost_usd`, `model_breakdown_json` (migration 0013). See `docs/logging.md`, "Cost and pricing data". Pin concrete ids for benchmarks; aliases move. (79aebb26)

### 🐛 Bug Fixes

- **A developer `.env` can no longer break (or mask) the release gates.** `nx` exports the repo-root `.env` into every task; its relative `ADHD_AGENT_DATABASE_PATH` (rejected by the BK6 store-path rule, which is unchanged) failed `agent-mcp:test` (`registry-prompt-resolver`) and `agent-mcp:verify-dist-load` on a checkout that has a `.env`, blocking publish. The unit lane now deletes inherited `ADHD_AGENT_*` variables in `vitest.setup.mjs` (new `hermetic-test-env.test.ts`), and `verify-dist-load` loads the built entry with `ADHD_*` scrubbed from the child environment (new spec). Use an absolute path for a dev store in `.env`; see the README configuration section.
- **Starting the server in `$HOME` no longer warns about `~/.adhd/.env`.** The `ignoring ADHD_AGENT_DATABASE_PATH in <file>` warning fired on the home file itself when the launch directory was `$HOME`, although that is the one file allowed to set the store path (its value was already applied). The launch-directory check now skips any file that resolves to the home file. (9ed453c1 BLIND F4)
- **`task` cwd reaches the spawned `claude` and its `fs` server.** See agent-engine-orchestrator. Ships migration `0014_task_cwd` (additive nullable `tasks.cwd`; legacy rows read `NULL` and fall back to the host cwd as before). New default-running e2e `claudecli-task-cwd.e2e.test.ts` drives the real `task` tool through `createServer` with a stand-in `claude` that is a real MCP client of the `fs` server (9ed453c1 CWD).

- **The spill read allow can no longer reach the agent database.** `agent.toolResult.spill.dir` is now validated as an allowlist: only `<temp>/tool-results` (and descendants) or a directory inside an `agent.shell.sandbox.extraAllowWriteRoots` root is accepted. Before, the whole `~/.adhd/agent-mcp` prefix was exempt from the protected-path check, so setting the spill dir to the data directory would have made the agent DB readable from the sandbox; that value, `<temp>` itself, logs, and a `tool-results` symlink into the data dir now abort startup. The explicit `provisionSrtPolicy({ spillReadDir })` path gets the same validation, with an optional `spillTempRoot`. (9ed453c1 HARD-H3)
- **A default plugin that fails to load is no longer silent.** When a default or configured plugin (tracing, budget, ...) cannot be resolved, imported, configured or installed at startup, agent-mcp now writes one `[agent-mcp] WARNING: default plugin <module> failed to load (<stage>): <reason>` line to stderr and an ops record `plugin.load_failed` (`plugin`, `stage`, `reason`, `default`), instead of only an error-level log that a quiet logger drops. The server still starts without the plugin. A production server with no tracing is now visible. See `docs/logging.md`. (c536ce29 E2E-PREREQ)
- **The `e2e` target builds the default plugins first.** `dependsOn` now names `agent-plugin-tracing:build` and `agent-plugin-budget:build` (they load by bare specifier at runtime, resolved through `dist/`), and the tracing e2e specs fail immediately with `npx nx build agent-plugin-tracing` in the message when the plugin did not load, instead of timing out with an empty diff. (c536ce29 E2E-PREREQ)
- **The store no longer depends on the launch directory.** A server started from the repo root with no overrides opened `data/agent-mcp/agents-dev.db` (the repo `.env` line `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db`, read relative to the cwd) while the same server launched from any other directory opened the production store `~/.adhd/agent-mcp/production/data/agents.db`. Now the production store is the default from every directory. `<cwd>/.env` and `<cwd>/.adhd/.env` can no longer set `ADHD_AGENT_DATABASE_PATH` (ignored, with a stderr warning naming the file); a relative `ADHD_AGENT_DATABASE_PATH` in the process environment fails startup (`must be an absolute path`) instead of resolving against the cwd; a relative path in `~/.adhd/.env` or the global `config.yaml` is anchored to that file's directory. Every start logs `store=<abs> mode=<production|custom> source=<env|cascade|default>`; `server.start` ops records gain `store_source` and `store_mode`; `mode` is derived from the path, there is no mode switch. (de046157)
- **Migration note.** If you relied on the repo `.env` to select the dev database, set an absolute path instead, in the process environment or in `~/.adhd/.env`: `ADHD_AGENT_DATABASE_PATH=/Users/you/dev/node/adhd/data/agent-mcp/agents-dev.db`. Your `.env` values are not modified. Your dev database file is untouched; it is simply no longer opened unless you name it by absolute path.

- **Shell sandbox can reach the backlog store, narrowly.** The default `srt` policy now allows writes to `~/.adhd/backlog/production/data` only (the DB, WAL and lease dir `adhd-backlog` needs; `config.yaml` and `backups/` are denied), via the validated `agent.shell.sandbox.extraAllowWrite` key (plus `extraAllowWriteRoots` for a relocated store). The validator is an allowlist that resolves symlinks and compares case-folded/NFC, the key is read from the global scope only, an invalid value aborts startup, the extras go to the per-run policy file only (never the shared `~/.srt-settings.json`), and the policy file is `O_EXCL` + `0600`. `adhd-backlog` now unlinks planted symlink/hard-link sidecars before opening the store (a sandbox-planted `-wal` symlink previously let an unsandboxed run truncate a file outside the sandbox). Backlog 515a2b50.
- **Cache-write 1h tier.** Cold-cache `claudecli` cache writes are priced at the 1-hour rate when usage reports `cache_creation.ephemeral_1h_input_tokens`, so `task_usage.est_cost_usd` matches the vendor `total_cost_usd` (0.009595 vs the old 0.0060925 in the audited example). `pricing_history` rows gain `cache_write_1h_per_m`. (b726a987)

### 🚀 Features

- **Tool-result size cap.** A tool result longer than `ADHD_AGENT_TOOL_RESULT_MAX_CHARS` (config key `agent.toolResult.maxChars`, default `20000`) is shown to the model as its first 15000 chars, a marker, and its last 5000 chars, for every provider. Example: a 100,000-char `cat SKILL.md` result is re-sent each turn as about 20 KB instead of 100 KB (the measured cost was about 30k tokens per turn). `0` disables the cap; an invalid value fails at startup. Usage telemetry still measures the full result, and `TOOL_RESULT` events gain `truncated: true` and `original_chars`. See `docs/logging.md`. (3ad735bb)
- **Live model prices.** The server now prices usage from an append-only price history instead of a fixed table. On start it seeds the bundled OpenRouter snapshot (467 models, fetched 2026-10-08), then pulls the public `https://openrouter.ai/api/v1/models` feed every 24 hours (no API key, no credentials; 30 s timeout; one retry after `Retry-After`, capped at 120 s, on a network error, 5xx or 429). Several servers sharing one database coordinate through a ledger claim, so exactly one pulls. `PACKAGE_VERSION` is now exported from `server.ts` and sent in the pull's `User-Agent`. (37f6c511 1f1c8598) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **`pricing_refresh` tool** pulls now, bypassing the 24 h gate: `pricing_refresh { "accept": ["some/model-id"] }` returns `{status, ledger_id, fetched_at, models, new, changed, unchanged, anomalies, duration_ms, error?}`. A failed, invalid, empty or shrunk (under 50% of the previous model count) pull changes nothing, logs an ERROR, and the last good prices keep serving. (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **`pricing_history` tool** returns a model's observed price series ($ per million tokens, `observed_at` order, with `source` and `ledger_id`) plus pull status: `pricing_history { "model": "deepseek/deepseek-v4.1-flash" }` returns `{model, unit, rows, status: {last_ok, last_failed, price_age_hours, next_scheduled, anomaly_thresholds}}`. (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **Anomaly hold.** A price move of 20x or more (input or output, either direction) or an input price above $1000/M is held, not applied, and reported in `anomalies`; re-run `pricing_refresh` with `accept: [modelId]` to apply it. A 10x to 20x move is applied with a warning. (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **`usage_query` cost provenance and `group_by: "response_model"`.** Rows carry `response_model`, `cost_status` (`priced` | `unpriced_model` | `partial`), `cost_basis` (`vendor-direct` | `openrouter-estimate` | `owner-assumption`) and `pricing_ref`; summaries carry `priced_cost_usd`, `unpriced_tasks`, `unpriced_tokens`, `unpriced_models` and `price_age_hours`. `est_cost_usd` stays `null` (never 0) for an unpriced model. Example: `usage_query { "group_by": "response_model" }` groups spend by the model the provider reported serving each call. (37f6c511) ([0d59e617](https://github.com/PseudoSky/adhd/commit/0d59e617))
- **Migration 0012** adds `model_price_history` (append-only, enforced by triggers), `price_pull_ledger`, and six nullable provenance columns on `task_usage`. It is additive; legacy rows keep NULL provenance. (1f1c8598 37f6c511) ([bc340a5b](https://github.com/PseudoSky/adhd/commit/bc340a5b))
- **Host wiring:** the pricing service is created in `index.ts`, handed to `UsagePlugin` as its price source, passed to the server for the two tools, and stopped first on shutdown (the scheduler's timer is `unref`'d and an in-flight pull is aborted and its ledger row closed). (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))

### Known limits

- DeepSeek-direct traffic is billed by DeepSeek, not OpenRouter; its cost is an estimate from OpenRouter rates. `deepseek-flash` is priced as `deepseek/deepseek-v4.1-flash` under an owner-set assumption (`cost_basis: "owner-assumption"`, ticket 37f6c511). Use `group_by: "response_model"` to check which revision actually served the calls; the `claudecli` provider reports no response model.
- A held anomaly stays unapplied until someone calls `pricing_refresh` with `accept`; the daily pull never accepts one on its own.
- The feed carries no effective date, so a price is stamped with the time this server observed it; accuracy is bounded by the 24 h cadence. Time-of-day / tier `pricing.overrides` are stored verbatim and applied to nothing.
- The real-socket pricing tests (`pricing-pull.e2e.test.ts`, `pricing-live-feed.e2e.test.ts`) exist, but the e2e lane is paused locally by owner decision (backlog 8963c3cb); the unit lane uses an injected fake `fetch`.
- There is no setting to disable the daily pull.

### Release note (owner)

All changes in this section are additive for `@adhd/agent-mcp` consumers (new tools, new optional response fields, additive migration): minor bump recommended (2.3.6 to 2.4.0). Not bumped here.

## 2.3.7 (2026-10-08)

### 🚀 Features

- **agent-mcp:** default-load agent-plugin-tracing with typed tracing config, reuse existing telemetry provider, audit script + docs (0f760dcd, 5dff26e6) ([0891a3bc](https://github.com/PseudoSky/adhd/commit/0891a3bc))

### 🩹 Fixes

- **agent-mcp:** --help/--version/unknown-flag answered before any DB-opening import; prepare only sets core.hooksPath in the main checkout (3d6860dd, f2b26b12) ([9b881398](https://github.com/PseudoSky/adhd/commit/9b881398))
- **agent-engine-orchestrator:** agent_create/agent_update input accepts legacy apiKeyEnv/authTokenEnv (mapped to env.secret); document PF-1 provider fields and strict input in agent-mcp (2eddcf91, 3864449b) ([3848205c](https://github.com/PseudoSky/adhd/commit/3848205c))
- **agent-mcp:** agent_update is a no-op (no version bump/write) when the patch changes nothing (F-PERF-3) ([beb25964](https://github.com/PseudoSky/adhd/commit/beb25964))
- **githooks:** pre-push runs test only, e2e stays CI-only; machine-check NAT_TOOL_LIVE gate tables (8963c3cb, 90d07610) ([b3106036](https://github.com/PseudoSky/adhd/commit/b3106036))

### ❤️ Thank You

- pseudosky

## 2.3.6 (2026-10-07)

### 🚀 Features

- **agent-engine-orchestrator:** ask escalation climbs transitively to the nearest interactive ancestor, root-terminal deny (fc466f0b) ([6bd3e4f6](https://github.com/PseudoSky/adhd/commit/6bd3e4f6))
- **dispatch-orchestrator:** drop implicit claudecli agent default (fail closed); document session_update + provider selection (5ad2cf37 D-G(2)) ([5667dff8](https://github.com/PseudoSky/adhd/commit/5667dff8))
- **agent-mcp:** session_update tool, host default provider tier, registry seeding + provider-selection e2e (5ad2cf37 D-G(2)) ([ef9f72e6](https://github.com/PseudoSky/adhd/commit/ef9f72e6))

### 🩹 Fixes

- **agent-engine-orchestrator:** reconstruct rootTaskId/callingAgentName on re-dispatch (0d77376f) ([90df4a43](https://github.com/PseudoSky/adhd/commit/90df4a43))
- **agent-mcp:** silence dotenv banner on stdio stdout (a0806529) ([eae6661c](https://github.com/PseudoSky/adhd/commit/eae6661c))
- **agent-mcp:** assert pinned node fs launch + pinned shell, drop npm registry from srt allowlist, connectTimeoutMs type, docs (c9f0a791) ([b9ab73bc](https://github.com/PseudoSky/adhd/commit/b9ab73bc))
- **agent-mcp:** move gitnexus-singleton contract out of gitnexus-owned skill dir (2cd99264) ([ed73dec1](https://github.com/PseudoSky/adhd/commit/ed73dec1))
- **agent-mcp:** union caller cwd into srt allowWrite when fs.root is explicit; add 48dc agent-portability e2e (7e854708, 33713d33) ([5fee7923](https://github.com/PseudoSky/adhd/commit/5fee7923))

### ❤️ Thank You

- pseudosky

## 2.3.5 (2026-10-06)

### 🩹 Fixes

- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))
- **agent-engine-orchestrator:** route an escalated ask to the parent task (a0c0a826) ([85fa0dba](https://github.com/PseudoSky/adhd/commit/85fa0dba))
- **agent-engine-orchestrator:** require explicit approval for a permission ask (FIX 5) ([890076cb](https://github.com/PseudoSky/adhd/commit/890076cb))
- **agent-engine-orchestrator:** unify HITL gate on effectiveHitl; fail synchronous asks closed ([17f6dfb7](https://github.com/PseudoSky/adhd/commit/17f6dfb7))

### ❤️ Thank You

- pseudosky

## 2.3.3 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **test:** make the full affected gate green (3 latent test-hermeticity fixes) ([734f756d](https://github.com/PseudoSky/adhd/commit/734f756d))
- **nx:** restore main's load-bearing test.dependsOn the remodel silently dropped ([cff62c50](https://github.com/PseudoSky/adhd/commit/cff62c50))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 2.3.2 (2026-09-24)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.3.1 (2026-08-14)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.3.0 (2026-08-11)


### 🩹 Fixes

- **agent-mcp:** reject bare trailing --host instead of installing to all hosts (DEBT-AGENTMCP-INSTALL-HOST-DEFAULT-001)

- **backlog:** DEBT-AGENTMCP-MIGRATION-PINNED-MARKER-001 — defer migration when operational DB is pinned to the flat legacy path

- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — typed TestDb access + hitl resolver-before-status ordering

- **agent-mcp:** reject bare trailing --scope instead of silently installing to all hosts (DEBT-AGENTMCP-INSTALL-HOST-DEFAULT-001 scope mirror)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)


### ❤️  Thank You

- pseudosky

## Unreleased


### 🚀 Features

- **agent-mcp:** new `agent-mcp-install` bin registers the MCP server into claude/opencode/codex host configs at user or project scope — `npx -y --package @adhd/agent-mcp@latest agent-mcp-install --host opencode --scope user` (BUG-AGENTMCP-006)

- **agent-mcp:** standardized, portable native tooling — `AgentDefinition.nativeTooling` (`{ fs?, shell?, dispatch?, hitl? }`) is resolved at **task time** against the dispatching cwd by `@adhd/agent-core-native-tooling`, with `ADHD_AGENT_NATIVE_TOOLING_*` config overrides (ADR-0008)

### ⚠️ Breaking Changes

- **agent-mcp:** the authored `tools/mcp-shell/server.mjs` fallback and its `ADHD_AGENT_SHELL_MCP_PATH` path override are **removed** (NAT-TOOL-4). Shell execution is now the adopted `tumf/mcp-shell-server` (`uvx mcp-shell-server`, allowlisted argv — never a shell string) wrapped by `srt`, configured via `nativeTooling.shell.*`. The create-time `buildDefaultMcpServers` helper is gone; `@adhd/agent-core-native-tooling` is the single fs/shell producer and `withDefaultMcpServers` merges at task time.

- **agent-mcp:** the resolved `nativeTooling.*.permissions` gate is **enforced** before every native tool call (NAT-TOOL-6). `deny` returns a typed `PERMISSION_DENIED` and the tool does not execute; `ask` resolves through the fixed chain `suspend → escalate → deny`. The retired `askPolicy`/`ephemeralAskPolicy` knobs no longer apply (ADR-0008 D5/D6).

## 2.2.3 (2026-08-08)


### 🩹 Fixes

- **agent-mcp:** assert a DELTA on REPO_ROOT/data, not an absolute — unblocks 2.2.2 publish

- **build:** route ESM packages' test target through dist-manifest + fail loud on type divergence (BUG-020)

- **agent-mcp:** pin operational data dir scope to global (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001)


### ❤️  Thank You

- pseudosky

## 2.2.2 (2026-08-07)


### 🩹 Fixes

- **agent-mcp:** eliminate double-import flakiness in real-environment.e2e.test.ts

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 2.2.1 (2026-07-27)

Fixes BUG-011 (CRITICAL): the process-entrypoint guard in `src/index.ts`
compared `path.resolve(process.argv[1])` — which only normalizes a path and
never resolves symlinks — against `import.meta.url`, which Node always
resolves to the loaded module's realpath. Any symlinked launch (npm/npx's
`node_modules/.bin/agent-mcp`, pnpm's symlinked store, an MCP host's
`type:local` launcher, or macOS's `/tmp` -> `/private/tmp`) therefore always
had `argv[1]` (the symlink) mismatch `import.meta.url` (the realpath), so
`isMainModule` was always `false` and `main()` never ran — the process
loaded env then exited 0 silently: no server bound, no port, no DB touched.
This made every `npx @adhd/agent-mcp` / opencode `type:local` launch a
silent no-op. Fixed by resolving `argv[1]` through `realpathSync` before
comparing (falling back to the old normalize-only comparison if `argv[1]`
can't be realpath'd), with a `computeIsMainModule()` teeth test that spawns
the real built `dist/src/index.js` through an actual filesystem symlink and
asserts the real HTTP transport port becomes reachable — proven red against
the pre-fix guard (20s timeout, `ECONNREFUSED`, child exits 0 silently) and
green against the fix.

## 2.1.5 (2026-07-26)

Ships proper usage accounting and budget enforcement, plus the claudecli provider usage fix (e660126b) — fixes BUG-MCP-PLUGIN-CONFIG-001 (the `@adhd/agent-plugin-budget` dependency was missing from `package.json`, so the config-driven `loadExternalPlugins()` path could never actually resolve/load it at runtime, even though the config plumbing itself was already correct). Also fixes BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001 downstream: republishing `@adhd/agent-store-tools`, `@adhd/agent-engine-orchestrator`, and the `@adhd/agent-core-*`/`@adhd/agent-store-*` family at their now-settled versions makes every internal `@adhd/*` dependency range in this release resolve to a real published version.

## 2.1.4 (2026-07-24)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.1.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### 🩹 Fixes

- **agent-mcp:** publish from dist — add packageRoot config, narrow asset glob (drops stray dist project.json), add publishConfig

- **agent-mcp:** 2.1.1 — ship drizzle migrations + pin external deps (2.1.0 was broken)

<!-- Historical entry (2.1.3, 2026-07-23): this agent-mcp-tail usage-accounting fix has no backlog graph ID — it was tracked pre-migration as BUG-AGENTMCP-006 in the old markdown BACKLOG.md (FIXED 2026-07-15, commit 2c42cf67), and that ID was later recycled for the opencode-install bug. Do not re-attach BUG-AGENTMCP-006 here (DEBT-AGENTMCP-CHANGELOG-ID-COLLISION-001). -->
- **agent-mcp:** agent-mcp-tail no longer fans per-task usage across every event

- **agent-mcp:** create + migrate registry DB on fresh machines instead of crashing SQLITE_CANTOPEN

- **agent-mcp:** eliminate SSE-port contention across concurrent stdio instances


### ❤️  Thank You

- pseudosky

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.2] - 2026-07-11

### Fixed

#### Cache-preserving context management (BUG-ORCH-008)

Fixes a critical regression where the context limiter destroyed provider prefix caching, causing 3-4x cost inflation.

**Problem:** When `ADHD_AGENT_CONTEXT_LIMIT > 0`, the `windowMessages` function dropped the oldest conversation messages to stay under the token limit. This mutated the message prefix, which all four major providers (Anthropic, OpenAI, DeepSeek, Gemini) use for efficient caching. Prefix caches provide up to 90% token cost reduction on stateless chat APIs; destroying the prefix on every trim forced full-price re-billing of the entire surviving history.

Measured on wire (DeepSeek v4-flash, 24 model calls):
- With prefix intact: 93-100% cache hit rate
- Calls where prefix was trimmed: 5-6% cache hit rate
- Full-price tokens wasted by 4 trim events: 154,224 tokens (81% of all full-price input in the run)
- Net cost inflation: ~3.15x–3.3x

**Fix:** Replaced with append-only message history. Context enforcement now:
1. Monitors the provider's exact `prompt_tokens` from each response (no more local estimation)
2. Only acts when approaching the model's real context ceiling (e.g., 90% of 1M for deepseek-v4-flash)
3. When action is needed, collapses middle messages into a single synthetic summary exactly once, preserving the prefix

**Breaking change:** `ADHD_AGENT_CONTEXT_LIMIT` now defaults to `0` (disabled). The previous hardcoded 30,000-token default is removed. Users should either:
- Keep the limit disabled (0) and rely on provider ceilings
- Implement input-capping at the source (limit individual tool-result sizes) instead of evicting from the conversation
- Set a per-model override if an operator-enforced cost cap is needed

**Related docs:** `docs/ideas/context-and-cache-strategy.md` in the monorepo contains the complete analysis, wire captures, and design rationale.

#### Provider-neutral token accounting (BUG-ORCH-009, BUG-ORCH-010)

Fixes a critical gap where cache-hit/miss tokens were dropped for OpenAI-compatible providers, and peak-context-size was never tracked.

**Problem:** 
- `inputTokens` is computed differently per provider: Anthropic excludes cached tokens, but OpenAI, DeepSeek, and Gemini include them. This silently broke cross-provider cost aggregation.
- No field tracked the peak prompt size in a single call; only cumulative sum existed. This made it impossible to distinguish "many small calls" (fix: fewer calls, preserve cache) from "one huge call" (fix: cap that input).
- DeepSeek and Anthropic responses carry cache-hit/miss breakdown, but the shipped OpenAI provider dropped these fields entirely on the wire.

**Fix:**
- New normalized usage fields (per-call and in task summary):
  - `uncachedInputTokens` — tokens billed at full rate (cache-miss rate for DeepSeek; input minus cached for Anthropic)
  - `cacheReadTokens` — tokens billed at cache-hit rate (cache-hit for DeepSeek; cache_read for Anthropic)
  - `cacheCreationTokens` — Anthropic cache-creation surcharge (undefined for DeepSeek/OpenAI, which don't charge writes separately)
  - `reasoningTokens` — inference tokens when the provider reports them
  - `peakContextTokens` — maximum prompt size in any single call (new, tracked per-task via `MAX()`, not sum)

- Task usage report now surfaces cache-hit rate and peak context alongside cumulative totals
- Provider mappings for OpenAI now capture `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `reasoning_tokens` from DeepSeek and reasoning-capable models

**Database migration:** `0008` adds:
- `task_usage.peak_context_tokens` (integer)
- `task_usage.peak_context_at` (integer — the 1-based model-call number that hit the peak)

**Breaking change:** Code reading `task_usage.inputTokens` must distinguish:
- `cumulativeBilledInputTokens` (what `inputTokens` was; cumulative sum across all calls)
- `peakContextTokens` (new; max single-call prompt size; the relevant metric for window limits)

#### Create-time environment-variable guard restored (BUG-ORCH-011)

Fixes a security regression where arbitrary host environment variables could be injected into agent provider credentials.

**Problem:** The `agent_create` and `agent_update` schemas had an `envNameGuard` validation rule that enforced `ADHD_AGENT_` prefix on all provider environment variable names. During refactoring to TypeScript, this was extracted into a factory function but never wired into the schemas, silently allowing injection of variables like `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, etc.

**Fix:** Re-wired `buildEnvNameGuard()` into both `agentCreateInputSchema` and `agentUpdateInputSchema`.

**Impact:** Existing agents with non-`ADHD_AGENT_` prefixed environment variables will fail validation on next update. These agents must be recreated with compliant env names.

#### Sessions→agents foreign-key cascade restored (BUG-ORCH-012)

Fixes a data-integrity regression where deleting an agent orphaned all its sessions and messages.

**Problem:** Migration `0007_smart_callisto.sql` restructured the schema, moving `agents` table from `agent-mcp` to `agent-store-runtime`. Drizzle's auto-generated migration silently dropped the `sessions.agent_name → agents.name ON DELETE CASCADE` foreign-key constraint. This meant `agent_delete` would delete the agent row but leave all sessions and messages orphaned, making them impossible to clean up without manual SQL.

**Fix:** Migration `0009_restore_fk_cascade.sql` restores the cascade constraint.

**Impact:** Existing orphaned sessions remain in the database (backward-compatible; no data is deleted). All future agent deletions will cascade correctly. Consider manual cleanup of orphaned sessions from prior 2.0.0/2.0.1 deletions if space is a concern.

#### Default tool advertisement restored to full JSON schemas (BUG-ORCH-013)

Fixes a silent breaking change where agents lost structured tool-call validation.

**Problem:** A new `toolAdvertisement` configuration field was added, defaulting to `'names'` (name + prose description only) for all non-claudecli providers. This was a silent wire-format change: every agent created under 2.0.0/2.0.1 without an explicit `toolAdvertisement` value lost full JSON-Schema function-calling definitions, replacing them with a prose-doc block in the system message. This affects provider-side validation and model-side tool-call accuracy.

**Fix:** Restored full JSON-Schema as the default for `toolAdvertisement`. Name-only mode remains available via explicit `toolAdvertisement: 'names'` on agent creation.

**Impact:** Agents created under 2.0.0/2.0.1 without explicit `toolAdvertisement` setting will now see full schemas in their next task. No migration needed; the change applies on next run.

#### Plugin global-config back-compat (BUG-ORCH-014)

Fixes a silent breaking change where existing global plugin configs stopped loading.

**Problem:** The plugin-loader's `findConfigFile()` function was updated to check `~/.adhd/agent-mcp/config.json` (new preferred location) but silently dropped the fallback to `~/.agent-mcp/config.json` (legacy location). Users with existing configs at the old path would get zero plugins loaded, with no warning.

**Fix:** Restored the fallback chain:
1. `~/.adhd/agent-mcp/config.json` (new preferred)
2. `./.adhd/agent-mcp/config.json` (project-local)
3. `~/.agent-mcp/config.json` (legacy, now explicitly supported)

**Impact:** Existing global configs at `~/.agent-mcp/config.json` will load again. No migration needed.

---

## [2.0.1] - (prior release)

Refer to commit history for 2.0.1 changes.

## [2.0.0] - (prior release)

Initial TypeScript rewrite of the agent-mcp runtime.
