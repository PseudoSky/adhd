# Package adversarial review (dispatch-1014, 2026-10-14)

Scope: every npm-style package under `packages/*`, `entrypoint/*`, `tools/nx-plugins/*` (74 manifests), plus non-manifest units under `packages/apigen/*` and `tools/*`. Read-only: `rg`, `gx`, `git log`, the backlog graph, npm downloads API. No builds or tests were run.

## Verdict counts

- KEEP: 67
- MERGE: 4
- WASTE: 8
- SHRINK: 6

## Method and rules

- A verdict needs a "how it is wired" line. Where usage could not be established the text says UNKNOWN.
- **WASTE** requires all of: zero (or only self/test) importers by real import statements, no wiring by config string/executor/plugin/bin, no external consumer evidence, and no live roadmap dependency. Each is cited.
- **Importer counts** are real import/require/dynamic-import statements (regex `(from|require\(|import\()\s*['"]@adhd/<name>`), excluding tests, fixtures, docs and node_modules. Comments and docstrings do not count. An earlier substring scan over-counted (it counted comments like config.ts/loader.ts mentions) and under-counted config-string wiring, so wiring by nx.json plugin, project.json executor, githook, CI workflow and default-plugin strings was checked separately and is stated per package.
- **Downloads caveat:** npm last-month downloads cannot separate external users from mirror/CI/smoke-test traffic. Every published @adhd package sits between about 400 and 3000/mo, including a one-function stub (apigen-base-types 555) and packages with no dependents. Treat downloads as a floor, never as evidence of use. External consumers are therefore UNKNOWN for every package; WASTE verdicts rest on the package having nothing consumable or no function in the repo, not on downloads.
- **Roadmap check** used the live backlog graph (`backlog_query`) and open items, not doc-mention counts. Decision rule: a roadmap dependency means another planned deliverable needs the package; an item that only asks the package to finish itself (DEBT-ENV-CLI-002) does not count.
- **Duplication** checks: agent-core-policy vs entrypoint/policy + policy-core-client (different layers: registry policy tables on the compileAgent path vs a general ABAC engine; convergence is a design question, UNKNOWN); agent-plugin-tracing vs apigen-plugin-tracing (different hosts, not the same hooks); the three nx generator packages (agent-generator-plugin, workspace-codegen-nx, apigen-generator-nx: distinct output, but agent-generator-plugin is the weakest, hence MERGE).
- Runtime reachability computed by BFS over real imports + package.json dependencies from every `entrypoint/*` plus config-wired roots (nx.json plugins, executors, githooks, default plugin strings).

## Summary table

| package | verdict | confidence | importers (real, non-test) | one-line wiring |
|---|---|---|---|---|
| @adhd/agent-base-types | KEEP | HIGH | 11 | Real import statements (non-test) from: dispatch-cli, agent-mcp, dispatch-base-spec, agent-core-policy, agent-core-native-tooling, agent-plugin-budget, agent-plugin-tracing, agent-store-runtime, agent-engine-orchestrator, agent-co |
| @adhd/agent-core-env | KEEP | HIGH | 3 | Real import statements (non-test) from: agent-mcp, agent-store-prompts, agent-engine-compiler. Reachable from entrypoint/root via agent-mcp > agent-core-env. |
| @adhd/agent-core-native-tooling | KEEP | HIGH | 3 | Real import statements (non-test) from: dispatch-cli, agent-mcp, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-core-native-tooling. |
| @adhd/agent-core-policy | KEEP | MEDIUM | 1 | agent-engine-compiler imports it (migrate-registry.ts:49) -> agent-mcp; AgentPolicyStore sits on the compileAgent path. |
| @adhd/agent-core-provider | KEEP | HIGH | 4 | Real import statements (non-test) from: agent-mcp, agent-engine-compiler, agent-plugin-budget, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-core-provider. |
| @adhd/agent-engine-compiler | KEEP | MEDIUM | 2 | Real import statements (non-test) from: agent-mcp, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-engine-compiler. |
| @adhd/agent-engine-orchestrator | KEEP | MEDIUM | 1 | Real import statements (non-test) from: agent-mcp. Reachable from entrypoint/root via agent-mcp > agent-engine-orchestrator. |
| @adhd/agent-generator-plugin | MERGE | LOW | 0 | Zero importers; an nx generator (`registry-package`) reachable only via `nx g`; build-checked at root project.json:18. |
| @adhd/agent-plugin-budget | KEEP | HIGH | 0 | Default-loaded by module string, so it has NO import statements by design: entrypoint/agent-mcp/src/config.ts:1117 `DEFAULT_BUDGET_PLUGIN_MODULE`, declared dependency of agent-mcp. |
| @adhd/agent-plugin-sanitize | KEEP | LOW | 0 | No import statement and not a default plugin: opt-in via agent-mcp config `plugins:[{module:"@adhd/agent-plugin-sanitize"}]` (README). The host still emits its hook. |
| @adhd/agent-plugin-tracing | KEEP | HIGH | 1 | agent-mcp imports it in 9 files (server.ts:23, wire/*.ts) and default-loads it (config.ts:1118). |
| @adhd/agent-store-prompts | KEEP | HIGH | 3 | Real import statements (non-test) from: agent-mcp, agent-engine-compiler, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-store-prompts. |
| @adhd/agent-store-runtime | KEEP | HIGH | 3 | Real import statements (non-test) from: agent-mcp, agent-plugin-budget, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-store-runtime. |
| @adhd/agent-store-tools | KEEP | MEDIUM | 1 | Real import statements (non-test) from: agent-engine-compiler. Reachable from entrypoint/root via agent-mcp > agent-engine-compiler > agent-store-tools. |
| @adhd/apigen-base-errors | KEEP | HIGH | 12 | Real import statements (non-test) from: policy-core-client, policy, apigen-engine-conformance, apigen-plugin-api-fastify, apigen-plugin-logger, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-engine-runtim |
| @adhd/apigen-base-logical | KEEP | HIGH | 7 | Real import statements (non-test) from: apigen-cli, (root/other:tools/vite-plugins), apigen-engine-conformance, apigen-core-client, apigen-engine-runtime, apigen-plugin-java-javalin, backlog. Reachable from entrypoint/root via api |
| @adhd/apigen-base-schema | WASTE | HIGH | 0 | No real import statement anywhere; tsconfig alias only. |
| @adhd/apigen-base-types | WASTE | HIGH | 0 | No real import statement anywhere; only its own spec calls its single export. |
| @adhd/apigen-core-client | KEEP | HIGH | 24 | Real import statements (non-test) from: policy, apigen-cli, apigen-engine-conformance, apigen-plugin-py-grpc, apigen-codegen-openapi, backlog, apigen-plugin-api-fastify, apigen-plugin-openapi, apigen-plugin-ir-cache, apigen-plugin |
| @adhd/apigen-engine-conformance | SHRINK | MEDIUM | 0 | Zero importers by design; it is a gate, run via its own `conformance`/`e2e` targets (project.json:21-67) and the CI Java-17 job (.github/workflows/ci.yml:39-47). |
| @adhd/apigen-engine-gateway | KEEP | LOW | 1 | Single prod importer: entrypoint/policy (and apigen-cli tests). |
| @adhd/apigen-engine-naming | KEEP | HIGH | 14 | Real import statements (non-test) from: policy, apigen-cli, apigen-engine-conformance, apigen-plugin-py-grpc, apigen-codegen-openapi, backlog, apigen-plugin-api-fastify, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-plugin-t |
| @adhd/apigen-engine-runtime | KEEP | HIGH | 10 | Real import statements (non-test) from: apigen-cli, policy, apigen-plugin-api-fastify, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-plugin-py-flask, apigen-plugin-policy, apigen-plugin-api-express, apig |
| @adhd/apigen-generator-nx | KEEP | HIGH | 0 | executor @adhd/apigen-generator-nx:generate at entrypoint/dispatch-cli/project.json:39 |
| @adhd/apigen-plugin-api-express | KEEP | MEDIUM | 1 | Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-api-express. |
| @adhd/apigen-plugin-api-fastify | KEEP | HIGH | 3 | Real import statements (non-test) from: apigen-cli, policy, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-api-fastify. |
| @adhd/apigen-plugin-batch | KEEP | MEDIUM | 2 | Real import statements (non-test) from: apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-batch. |
| @adhd/apigen-plugin-cli-output | KEEP | HIGH | 3 | Real import statements (non-test) from: apigen-cli, policy, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-cli-output. |
| @adhd/apigen-plugin-health | KEEP | MEDIUM | 1 | apigen-cli imports it; tests in express/fastify hosts exercise it. |
| @adhd/apigen-plugin-ir-cache | KEEP | MEDIUM | 2 | Real import statements (non-test) from: apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-ir-cache. |
| @adhd/apigen-plugin-java-javalin | KEEP | MEDIUM | 1 | Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-java-javalin. |
| @adhd/apigen-plugin-jsonschema | KEEP | MEDIUM | 1 | apigen-cli imports it. |
| @adhd/apigen-plugin-logger | KEEP | MEDIUM | 1 | apigen-cli and (via cli-output) the chain import it. |
| @adhd/apigen-plugin-mcp | KEEP | HIGH | 3 | Real import statements (non-test) from: apigen-cli, policy, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-mcp. |
| @adhd/apigen-plugin-openapi | KEEP | MEDIUM | 2 | Real import statements (non-test) from: apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-openapi. |
| @adhd/apigen-plugin-policy | KEEP | MEDIUM | 1 | entrypoint/policy imports it; not on npm yet (0.0.1, `not found`). |
| @adhd/apigen-plugin-py-flask | KEEP | MEDIUM | 1 | Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-py-flask. |
| @adhd/apigen-plugin-py-grpc | KEEP | MEDIUM | 1 | Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-py-grpc. |
| @adhd/apigen-plugin-tracing | KEEP | HIGH | 3 | Real import statements (non-test) from: policy, apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-tracing. |
| @adhd/apigen-plugin-ts-types | KEEP | MEDIUM | 1 | apigen-cli imports it. |
| @adhd/apigen-codegen-openapi | KEEP | MEDIUM | 1 | Real import statements (non-test) from: apigen-plugin-openapi. Reachable from entrypoint/root via apigen-cli > apigen-plugin-openapi > apigen-codegen-openapi. |
| @adhd/apigen-python-env | KEEP | HIGH | 4 | Real import statements (non-test) from: apigen-cli, apigen-engine-conformance, apigen-plugin-py-grpc, apigen-plugin-py-flask. Reachable from entrypoint/root via apigen-cli > apigen-python-env. |
| @adhd/data-base-transforms | KEEP | HIGH | 3 | Real import statements (non-test) from: data-query-engine, data-core-structures, decompile-cli. Reachable from entrypoint/root via decompile-cli > data-base-transforms. |
| @adhd/data-core-structures | MERGE | LOW | 1 | Only data-query-engine imports it (src/lib/model/indexing.ts:11: BPlusTree, PostingIndex, RoaringBitmap). |
| @adhd/data-query-engine | KEEP | MEDIUM | 1 | Real import statements (non-test) from: policy-core-client. Reachable from entrypoint/root via policy > policy-core-client > data-query-engine. |
| @adhd/dispatch-base-spec | KEEP | HIGH | 5 | Real import statements (non-test) from: dispatch-cli, dispatch-core-client, dispatch-serializer-json, dispatch-orchestrator, dispatch-core-optimizer. Reachable from entrypoint/root via dispatch-cli > dispatch-base-spec. |
| @adhd/dispatch-base-types | WASTE | HIGH | 0 | No real import statement anywhere; tsconfig alias only. |
| @adhd/dispatch-core-client | KEEP | HIGH | 3 | Real import statements (non-test) from: dispatch-cli, dispatch-serializer-json, dispatch-orchestrator. Reachable from entrypoint/root via dispatch-cli > dispatch-core-client. |
| @adhd/dispatch-core-optimizer | KEEP | MEDIUM | 1 | Real import statements (non-test) from: dispatch-cli. Reachable from entrypoint/root via dispatch-cli > dispatch-core-optimizer. |
| @adhd/dispatch-orchestrator | KEEP | MEDIUM | 1 | Real import statements (non-test) from: dispatch-cli. Reachable from entrypoint/root via dispatch-cli > dispatch-orchestrator. |
| @adhd/dispatch-serializer-json | MERGE | LOW | 1 | dispatch-cli imports it (real import); dispatch-orchestrator test-only. |
| @adhd/environment-base-spec | KEEP | HIGH | 6 | Real import statements (non-test) from: policy-core-client, agent-mcp, environment-builder, environment-cli, environment, backlog. Reachable from entrypoint/root via agent-mcp > environment-base-spec. |
| @adhd/environment-builder | KEEP | HIGH | 3 | Real import statements (non-test) from: environment-cli, environment, backlog. Reachable from entrypoint/root via backlog > environment-builder. |
| @adhd/environment | KEEP | HIGH | 6 | Real import statements (non-test) from: policy-core-client, agent-mcp, environment-cli, apigen-plugin-ir-cache, agent-core-env, backlog. Reachable from entrypoint/root via agent-mcp > environment. |
| @adhd/policy-core-client | KEEP | MEDIUM | 1 | entrypoint/policy imports it; it imports data-query-engine and environment. |
| @adhd/ui-react-base-hooks | SHRINK | LOW | 0 | Zero importers. Repo has no React app or component library; sole React surface (docs/ARCHITECTURE.md:65 "Dashboard components"). |
| @adhd/ui-react-base-storybook | MERGE | MEDIUM | 0 | Private; zero importers; wired only by root script `storybook` (package.json:18) and nx.json:273 exclusion. |
| @adhd/workspace-base-standard | SHRINK | MEDIUM | 0 | Zero importers; its README/PLAYBOOK say it is a core awaiting a consumer (`PKG-WS-NX-ADAPTER`) that has never landed. |
| @adhd/workspace-base-tools | WASTE | MEDIUM | 0 | No real import statement anywhere. Wired only in nx.json:141 (tsc build include) and tsconfig.base.json:202. |
| @adhd/workspace-base-vite-paths | KEEP | MEDIUM | 0 | Imported by relative path (not by package name) from entrypoint/agent-mcp/vite.config.ts:7 and entrypoint/policy/vite.config.ts:6; nx.json:44 namedInput. |
| @adhd/workspace-codegen-nx | KEEP | MEDIUM | 0 | No importer: it is the nx generator CLI mandated by AGENTS.md section 1 (`nx g @adhd/workspace-codegen-nx:<tier>`); nx.json:142 builds it. |
| @adhd/agent-mcp | KEEP | HIGH | 0 | No importer. Reachable from entrypoint/root via agent-mcp. |
| @adhd/apigen-cli | KEEP | HIGH | 0 | No importer. Reachable from entrypoint/root via apigen-cli. |
| @adhd/backlog | KEEP | HIGH | 0 | Declared dependency of: dispatch-cli (no import statement found). Reachable from entrypoint/root via backlog. |
| @adhd/decompile-cli | KEEP | LOW | 0 | Standalone published CLI (`decompile`); README.md:31 advertises it; depends on data-base-transforms; built in clean-room-smoke.spec.mjs:86. |
| @adhd/dispatch-cli | KEEP | HIGH | 0 | No importer. Reachable from entrypoint/root via dispatch-cli. |
| @adhd/environment-cli | WASTE | MEDIUM | 0 | Private package, no `bin`, no importer; consumed by nothing. |
| @adhd/policy | KEEP | HIGH | 0 | No importer. Reachable from entrypoint/root via policy. |
| @adhd/nx-assets | KEEP | MEDIUM | 0 | No importer. Reachable from entrypoint/root via nx-assets. |
| @adhd/nx-build | KEEP | MEDIUM | 0 | No importer. Reachable from entrypoint/root via nx-build. |
| @adhd/nx-deps | KEEP | HIGH | 0 | nx.json plugin ./tools/nx-plugins/deps/plugin.js |
| @adhd/nx-mass-delete-guard | KEEP | HIGH | 0 | root project.json:121 executor + .githooks/pre-commit |
| @adhd/nx-secret-scan | KEEP | HIGH | 0 | root project.json:48 executor + .githooks/pre-commit:113 + CI pull-request.yml:66 |
| @adhd/nx-test | KEEP | HIGH | 0 | nx.json plugin ./tools/nx-plugins/test/plugin.js |

### Non-manifest units

| unit | verdict | confidence | importers | one-line wiring |
|---|---|---|---|---|
| packages/apigen/plugins/demo-plugin | WASTE | HIGH | n/a | tsconfig.base.json:116 alias only; no package.json, no project.json, 0 references (`rg demo-plugin` outside tsconfig/self -> none). |
| packages/apigen/tools/vite-copy-readme.mjs | WASTE | MEDIUM | n/a | 0 references; differs from the live tools/vite-plugins/copy-readme.mjs (`diff -q` -> differ); commit bf74a157 claimed it moved to root tools/. |
| packages/apigen/tools/bench-extract.ts | SHRINK | LOW | n/a | Only referenced by the grooming extract (docs/backlog/grooming/wf_28c6a91a-4c9-extract.json:7487-7489), which calls it "silent"; not in any target. |
| tools/util/pbcopy.js | WASTE | HIGH | n/a | `rg pbcopy` over code/config -> only its own file; 1 commit-era file of 9 lines (macOS clipboard helper). |
| tools/ai-migrations | SHRINK | LOW | n/a | 8 prompt files referenced only from migrations.json:279,416,466,480,506 (nx migrate AI prompts for 23.2.1). Installed @nx/jest is 23.2.1. |
| tools/mcp-shell | SHRINK | LOW | n/a | Only security.yaml remains. In-repo reader is a contract test (docs-and-config-contract.test.ts:162-191) asserting it exists; README says machine-global agents point MCP_SHELL_SEC_CONFIG_FILE at it (external, UNKNOWN). |
| tools/evidence | KEEP | HIGH | n/a | Gated by `nx run @adhd/source:evidence-gates` (project.json:193-200), CI ci.yml:104; 3 scripts used by agent workflow (commit-mine, audit-closed-items). |
| tools/gate | KEEP | HIGH | n/a | lane-gate.mjs is the single source of GATE_TARGETS for pre-push and CI (.githooks/pre-push:7,38; project.json:57-66). |
| tools/vite-plugins | KEEP | HIGH | n/a | nx.json:40-43 namedInputs; every vite.config consumes externalize/source-resolution/vitest-pool-defaults. |
| packages/apigen/java | KEEP | HIGH | n/a | Maven module consumed by apigen-plugin-java-javalin and the live JVM conformance matrix; CI installs Temurin 17 for it (ci.yml:39-47). |
| packages/apigen/python | KEEP | HIGH | n/a | Python runtime (`apigen_logical.py`, grpc_server.py, run_tests.py) driven by py-flask/py-grpc plugins + conformance gate (gate.ts:497-502). |

## Bugs found while reviewing

1. `entrypoint/apigen-cli/project.json:75` target `generate-api` uses executor `@adhd/apigen-nx:generate`; no package of that name exists (not in tsconfig.base.json paths, not in node_modules/@adhd, `nx show project apigen-cli --json` still prints that executor string). The renamed package is `@adhd/apigen-generator-nx`. Nothing else references the target.
2. `workspace-base-vite-paths` is consumed by relative path from two vite.config.ts files, contrary to the import rule in AGENTS.md section 9.
3. `apigen-base-schema` header claims identity `@adhd/apigen-schema` (stale; backlog 805de7d5).
4. `memory_recall` vec channel timed out during the pre-write dedupe (12 s embed guard); BM25 returned no prior episodes.

## Unverified / UNKNOWN

- External npm consumers of any package.
- Whether tools/ai-migrations migration run was completed.
- Whether agent-plugin-sanitize and agent-core-policy's rate plugin are enabled by any real user config.
- Runtime behaviour was not exercised (read-only).

## Per-package evidence

### @adhd/agent-base-types (packages/agent/agent-base-types) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: dispatch-cli, agent-mcp, dispatch-base-spec, agent-core-policy, agent-core-native-tooling, agent-plugin-budget, agent-plugin-tracing, agent-store-runtime, agent-engine-orchestrator, agent-core-provider, agent-plugin-sanitize. Reachable from entrypoint/root via agent-mcp > agent-base-types.
- **Importers (real import statements, non-test):** 11
  - @adhd/dispatch-cli: entrypoint/dispatch-cli/src/lib/core.ts:31
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/store/agent-store.ts:20, entrypoint/agent-mcp/src/server.ts:29
  - @adhd/dispatch-base-spec: packages/dispatch/dispatch-base-spec/src/lib/types.ts:16
  - @adhd/agent-core-policy: packages/agent/agent-core-policy/src/plugin/index.ts:15, packages/agent/agent-core-policy/src/plugin/index.ts:25
  - @adhd/agent-core-native-tooling: packages/agent/agent-core-native-tooling/src/lib/resolver.ts:9, packages/agent/agent-core-native-tooling/src/lib/dispatch-self.ts:20
  - @adhd/agent-plugin-budget: packages/agent/agent-plugin-budget/src/index.ts:20, packages/agent/agent-plugin-budget/src/index.ts:21
  - @adhd/agent-plugin-tracing: packages/agent/agent-plugin-tracing/src/lib/runtime.ts:4, packages/agent/agent-plugin-tracing/src/lib/plugin.ts:3
  - @adhd/agent-store-runtime: packages/agent/agent-store-runtime/src/store/session-store.ts:29, packages/agent/agent-store-runtime/src/runtime/usage-client.ts:1
  - @adhd/agent-engine-orchestrator: packages/agent/agent-engine-orchestrator/src/validation/task.ts:15, packages/agent/agent-engine-orchestrator/src/validation/task.ts:37
  - @adhd/agent-core-provider: packages/agent/agent-core-provider/src/failure/heuristics.ts:14, packages/agent/agent-core-provider/src/failure/classify.ts:12
  - @adhd/agent-plugin-sanitize: packages/agent/agent-plugin-sanitize/src/index.ts:9
- **Test-only importers:** dispatch-orchestrator (packages/dispatch/dispatch-orchestrator/src/test/real-turn-telemetry.spec.ts:35)
- **package.json dependents:** agent-core-native-tooling, agent-core-policy, agent-core-provider, agent-engine-orchestrator, agent-plugin-budget, agent-plugin-sanitize, agent-plugin-tracing, agent-store-runtime, dispatch-base-spec, dispatch-orchestrator, agent-mcp, dispatch-cli
- **Published:** public v2.3.11; npm last-month downloads 2545/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-12 b3c4bd21 feat(agent-engine-orchestrator): R10 S5b engine trace emission - post:model_response turnIndex/thinkingConfig/thinkingBlocks/toolResultBytesIn from real data, task:startup typed (queueWaitMs/sessionMs optional), dispatch:completed toolCallId via per-call scope, result-wait dispatch event (R10 S5b AC1 AC2 AC3 AC4 AC5); 82 commits total; 16 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 11 real importer(s) (+1 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-core-env (packages/agent/agent-core-env) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: agent-mcp, agent-store-prompts, agent-engine-compiler. Reachable from entrypoint/root via agent-mcp > agent-core-env.
- **Importers (real import statements, non-test):** 3
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/index.ts:22, entrypoint/agent-mcp/src/db/client.ts:9
  - @adhd/agent-store-prompts: packages/agent/agent-store-prompts/drizzle.config.ts:3
  - @adhd/agent-engine-compiler: packages/agent/agent-engine-compiler/src/cli/compile.ts:42, packages/agent/agent-engine-compiler/drizzle.config.ts:3
- **Test-only importers:** (none)
- **package.json dependents:** agent-engine-compiler, agent-store-prompts, agent-mcp
- **Published:** public v0.1.5; npm last-month downloads 1255/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-08 8c0514d6 fix(agent-core-env): release 0.1.5 declaring @adhd/sox-store-adapter ^0.13.3 (Turso 0.8.2) to stop mixed-engine FTS drop/recreate (4b7fd623); 37 commits total; 16 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-core-native-tooling (packages/agent/agent-core-native-tooling) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: dispatch-cli, agent-mcp, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-core-native-tooling.
- **Importers (real import statements, non-test):** 3
  - @adhd/dispatch-cli: entrypoint/dispatch-cli/src/lib/core.ts:30
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/tool-result-notes.ts:63, entrypoint/agent-mcp/src/install.ts:30
  - @adhd/agent-engine-orchestrator: packages/agent/agent-engine-orchestrator/src/engine/native-tool-guidance.ts:7
- **Test-only importers:** (none)
- **package.json dependents:** agent-engine-orchestrator, agent-mcp, dispatch-cli
- **Published:** public v0.0.4; npm last-month downloads 734/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-12 11d757f4 feat(agent-engine-orchestrator): shell tool guidance lists generated allowlist, unavailable commands and verified curl title/heading recipes (R7-guidance AC1-AC3); 44 commits total; 21 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-core-policy (packages/agent/agent-core-policy) - KEEP (MEDIUM)

- **How it is wired:** agent-engine-compiler imports it (migrate-registry.ts:49) -> agent-mcp; AgentPolicyStore sits on the compileAgent path.
- **Importers (real import statements, non-test):** 1
  - @adhd/agent-engine-compiler: packages/agent/agent-engine-compiler/src/db/migrate-registry.ts:49, packages/agent/agent-engine-compiler/src/resolve/policy.ts:3
- **Test-only importers:** agent-mcp (entrypoint/agent-mcp/src/__tests__/registry-prompt-resolver.test.ts:62)
- **package.json dependents:** agent-engine-compiler
- **Published:** public v2.2.3; npm last-month downloads 823/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 4e465788 Committing: released items; 49 commits total; 19 source files
- **Adversarial attack:** Only 1 prod importer; its optional rate-policy plugin is not default-loaded; conceptually overlaps the separate general ABAC engine in entrypoint/policy + policy-core-client.
- **Self-refutation:** Self-refutation: `gx impact AgentPolicyStore` -> 13 impacted symbols, 2 processes (compileAgent), risk LOW; it owns registry policy tables. Whether to converge with @adhd/policy is a design question, UNKNOWN, not a waste verdict.
- **Evidence:** packages/agent/agent-engine-compiler/src/db/migrate-registry.ts:49; `gx impact AgentPolicyStore`

### @adhd/agent-core-provider (packages/agent/agent-core-provider) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: agent-mcp, agent-engine-compiler, agent-plugin-budget, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-core-provider.
- **Importers (real import statements, non-test):** 4
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/pricing/service.ts:9, entrypoint/agent-mcp/src/pricing/pull.ts:15
  - @adhd/agent-engine-compiler: packages/agent/agent-engine-compiler/src/db/migrate-registry.ts:37, packages/agent/agent-engine-compiler/src/compile.ts:39
  - @adhd/agent-plugin-budget: packages/agent/agent-plugin-budget/src/index.ts:22, packages/agent/agent-plugin-budget/src/index.ts:23
  - @adhd/agent-engine-orchestrator: packages/agent/agent-engine-orchestrator/src/index.ts:82, packages/agent/agent-engine-orchestrator/src/index.ts:83
- **Test-only importers:** (none)
- **package.json dependents:** agent-engine-compiler, agent-engine-orchestrator, agent-plugin-budget, agent-mcp
- **Published:** public v2.2.9; npm last-month downloads 1915/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-12 1eb61b08 feat(agent-mcp): parity R7-think: thinking is the model default on every arm (report-only), main-tree LOG scope gate, sonnet-5 context/max-tokens/rate card; 67 commits total; 46 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 4 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-engine-compiler (packages/agent/agent-engine-compiler) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: agent-mcp, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-engine-compiler.
- **Importers (real import statements, non-test):** 2
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/index.ts:85, entrypoint/agent-mcp/src/index.ts:345
  - @adhd/agent-engine-orchestrator: packages/agent/agent-engine-orchestrator/src/engine/prompt-resolver.ts:5
- **Test-only importers:** (none)
- **package.json dependents:** agent-engine-orchestrator, agent-mcp
- **Published:** public v2.2.8; npm last-month downloads 1385/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 4e465788 Committing: released items; 64 commits total; 29 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 2 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-engine-orchestrator (packages/agent/agent-engine-orchestrator) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: agent-mcp. Reachable from entrypoint/root via agent-mcp > agent-engine-orchestrator.
- **Importers (real import statements, non-test):** 1
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/store/agent-store.ts:13, entrypoint/agent-mcp/src/store/agent-store.ts:18
- **Test-only importers:** agent-plugin-tracing (packages/agent/agent-plugin-tracing/src/lib/tool-queue-real-engine.test.ts:12), dispatch-orchestrator (packages/dispatch/dispatch-orchestrator/src/test/policy-dispatch-log.spec.ts:40)
- **package.json dependents:** agent-plugin-tracing, dispatch-orchestrator, agent-mcp
- **Published:** public v2.3.13; npm last-month downloads 2412/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-14 3b83db8a fix(agent-engine-orchestrator): temp-root test redirects os.tmpdir and usage chunking test splits its 33k seed (b941dcd3); 270 commits total; 242 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s) (+2 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-generator-plugin (packages/agent/agent-generator-plugin) - MERGE (LOW)

- **How it is wired:** Zero importers; an nx generator (`registry-package`) reachable only via `nx g`; build-checked at root project.json:18.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** no publishConfig v0.1.7; npm last-month downloads 954/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-25 cb25428a docs(agent-generator-plugin): document input constraints and fix stale README file claims; 33 commits total; 7 source files
- **Adversarial attack:** Scaffolds the agent-store family; all 12 agent-* packages already exist and AGENTS.md mandates `@adhd/workspace-codegen-nx` for scaffolding. Generator code still emits `@nx/js:tsc` build target (src/generators/registry-package/generator.ts:72). Open hygiene items a1bd135b (dead vite block, stale devkit pins). Third nx generator package alongside workspace-codegen-nx and apigen-generator-nx.
- **Self-refutation:** Self-refutation: it encodes registry-family invariants (table-prefix collision guard, REGISTRY-PACKAGE-RULES.md) that workspace-codegen-nx does not, and the default projectDir is now correct (`packages/agent/${projectName}`, generator.ts:30), so earlier "dead packages/ai path" claims (from an ETL fixture) are no longer true. Future agent-store packages would need it. LOW confidence: usage by humans via `nx g` is UNKNOWN.
- **Evidence:** packages/agent/agent-generator-plugin/generators.json:3-5; src/generators/registry-package/generator.ts:30,72; project.json:18 (root); backlog a1bd135b-5183-479d-95dc-aae2cdb05dd1

### @adhd/agent-plugin-budget (packages/agent/agent-plugin-budget) - KEEP (HIGH)

- **How it is wired:** Default-loaded by module string, so it has NO import statements by design: entrypoint/agent-mcp/src/config.ts:1117 `DEFAULT_BUDGET_PLUGIN_MODULE`, declared dependency of agent-mcp.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** agent-mcp (entrypoint/agent-mcp/src/__tests__/typed-task-events.test.ts:110), agent-engine-orchestrator (packages/agent/agent-engine-orchestrator/src/__tests__/budget-warn-never-blocks.test.ts:6)
- **package.json dependents:** agent-engine-orchestrator, agent-mcp
- **Published:** public v0.2.9; npm last-month downloads 1646/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-11 6abde7cb test(agent-plugin-budget): cite cbe0b6ce in the provider-override tests; 67 commits total; 6 source files
- **Adversarial attack:** Importer scan finds 0 prod importers; a naive scan would call it dead.
- **Self-refutation:** Refuted: it is a default plugin of the flagship entrypoint (config.ts:1147 defaults), registers `transform:tool_result` (index.ts:819).
- **Evidence:** entrypoint/agent-mcp/src/config.ts:1117,1147; entrypoint/agent-mcp/package.json:32

### @adhd/agent-plugin-sanitize (packages/agent/agent-plugin-sanitize) - KEEP (LOW)

- **How it is wired:** No import statement and not a default plugin: opt-in via agent-mcp config `plugins:[{module:"@adhd/agent-plugin-sanitize"}]` (README). The host still emits its hook.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.1.5; npm last-month downloads 579/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-12 9c8d9bf1 docs(agent-engine-orchestrator): document provider echo persistence, TTL, degrade, pause_turn cap, privacy, events, hook, config keys, migration 0017 and usage accounting (R9-hist S8); 40 commits total; 5 source files
- **Adversarial attack:** Zero static importers and not default-loaded, so real use is UNKNOWN.
- **Self-refutation:** Self-refutation (settles it): `hooks.emit("transform:tool_result")` still fires at orchestrator.ts:1828 and :2566, the plugin targets `agent-mcp__task`/`agent-mcp__agent` (index.ts:64) which delegation-text.ts/server.ts still serve, and open backlog B08 (fdb79d6f) is actively hardening it. The orchestrator persist veto (orchestrator.ts:1991) governs echo persistence, not model-facing wrapping, so it is not a duplicate. Alive but unproven in use.
- **Evidence:** packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts:1828,2566; packages/agent/agent-plugin-sanitize/src/index.ts:64,75; backlog fdb79d6f-7538-440e-a4cd-8895723e5a4c

### @adhd/agent-plugin-tracing (packages/agent/agent-plugin-tracing) - KEEP (HIGH)

- **How it is wired:** agent-mcp imports it in 9 files (server.ts:23, wire/*.ts) and default-loads it (config.ts:1118).
- **Importers (real import statements, non-test):** 1
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/server.ts:23, entrypoint/agent-mcp/src/pricing/service.ts:8
- **Test-only importers:** (none)
- **package.json dependents:** agent-mcp
- **Published:** public v0.0.3; npm last-month downloads 681/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-13 bf697224 test(agent-plugin-tracing): real-engine proof of engine-final queued_ms and group_index on anthropic, openai-compatible and claudecli (a2a9c6db AC1); 23 commits total; 23 source files
- **Adversarial attack:** Only one consumer (agent-mcp).
- **Self-refutation:** Refuted: it is agent-mcp telemetry spine; apigen-plugin-tracing is the apigen-host analogue with a different payload (spans for apigen servers), not a duplicate implementation of the same hooks.
- **Evidence:** entrypoint/agent-mcp/src/server.ts:23; src/wire/channels.ts:29; src/config.ts:1118

### @adhd/agent-store-prompts (packages/agent/agent-store-prompts) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: agent-mcp, agent-engine-compiler, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-store-prompts.
- **Importers (real import statements, non-test):** 3
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/index.ts:24, entrypoint/agent-mcp/src/index.ts:75
  - @adhd/agent-engine-compiler: packages/agent/agent-engine-compiler/src/db/migrate-registry.ts:41, packages/agent/agent-engine-compiler/src/cli/compile.ts:43
  - @adhd/agent-engine-orchestrator: packages/agent/agent-engine-orchestrator/src/engine/prompt-resolver.ts:6
- **Test-only importers:** (none)
- **package.json dependents:** agent-engine-compiler, agent-engine-orchestrator, agent-mcp
- **Published:** public v2.2.3; npm last-month downloads 943/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 35bbcbf0 feat(nx-build): release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069); 41 commits total; 22 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-store-runtime (packages/agent/agent-store-runtime) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: agent-mcp, agent-plugin-budget, agent-engine-orchestrator. Reachable from entrypoint/root via agent-mcp > agent-store-runtime.
- **Importers (real import statements, non-test):** 3
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/store/agent-store.ts:8, entrypoint/agent-mcp/src/store/agent-store.ts:19
  - @adhd/agent-plugin-budget: packages/agent/agent-plugin-budget/src/index.ts:24
  - @adhd/agent-engine-orchestrator: packages/agent/agent-engine-orchestrator/src/engine/dag-engine.ts:4, packages/agent/agent-engine-orchestrator/src/plugins/usage-plugin.ts:5
- **Test-only importers:** dispatch-orchestrator (packages/dispatch/dispatch-orchestrator/src/test/real-turn-telemetry.spec.ts:33), agent-plugin-tracing (packages/agent/agent-plugin-tracing/src/test/harness.ts:15)
- **package.json dependents:** agent-engine-orchestrator, agent-plugin-budget, agent-plugin-tracing, dispatch-orchestrator, agent-mcp
- **Published:** public v2.2.10; npm last-month downloads 1915/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-12 9c8d9bf1 docs(agent-engine-orchestrator): document provider echo persistence, TTL, degrade, pause_turn cap, privacy, events, hook, config keys, migration 0017 and usage accounting (R9-hist S8); 70 commits total; 25 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s) (+2 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/agent-store-tools (packages/agent/agent-store-tools) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: agent-engine-compiler. Reachable from entrypoint/root via agent-mcp > agent-engine-compiler > agent-store-tools.
- **Importers (real import statements, non-test):** 1
  - @adhd/agent-engine-compiler: packages/agent/agent-engine-compiler/src/db/migrate-registry.ts:45, packages/agent/agent-engine-compiler/src/compile.ts:38
- **Test-only importers:** agent-mcp (entrypoint/agent-mcp/src/__tests__/registry-prompt-resolver.test.ts:60)
- **package.json dependents:** agent-engine-compiler
- **Published:** public v2.2.3; npm last-month downloads 824/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 35bbcbf0 feat(nx-build): release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069); 41 commits total; 21 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s) (+1 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-base-errors (packages/apigen/apigen-base-errors) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: policy-core-client, policy, apigen-engine-conformance, apigen-plugin-api-fastify, apigen-plugin-logger, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-engine-runtime, apigen-plugin-policy, apigen-plugin-api-express, apigen-engine-gateway. Reachable from entrypoint/root via policy > apigen-base-errors.
- **Importers (real import statements, non-test):** 12
  - @adhd/policy-core-client: packages/policy/policy-core-client/src/service/api.ts:1, packages/policy/policy-core-client/src/service/ctx.ts:1
  - @adhd/policy: entrypoint/policy/src/wrapper/http-port.ts:1, entrypoint/policy/src/wrapper/flags.ts:1
  - @adhd/apigen-engine-conformance: packages/apigen/apigen-engine-conformance/src/lib/vectors.ts:33
  - @adhd/apigen-plugin-api-fastify: packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:1, packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:2
  - @adhd/apigen-plugin-logger: packages/apigen/apigen-plugin-logger/src/lib/plugin.ts:12
  - @adhd/apigen-plugin-batch: packages/apigen/apigen-plugin-batch/src/lib/plugin.ts:25
  - @adhd/apigen-plugin-cli-output: packages/apigen/apigen-plugin-cli-output/src/lib/run.ts:31, packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts:4
  - @adhd/apigen-plugin-mcp: packages/apigen/apigen-plugin-mcp/src/lib/run.ts:50, packages/apigen/apigen-plugin-mcp/src/lib/stream.ts:32
  - @adhd/apigen-engine-runtime: packages/apigen/apigen-engine-runtime/src/lib/validate-layer.ts:37, packages/apigen/apigen-engine-runtime/src/lib/batch.ts:20
  - @adhd/apigen-plugin-policy: packages/apigen/apigen-plugin-policy/src/plugin.ts:1
  - @adhd/apigen-plugin-api-express: packages/apigen/apigen-plugin-api-express/src/lib/run.ts:35, packages/apigen/apigen-plugin-api-express/src/lib/run.ts:37
  - @adhd/apigen-engine-gateway: packages/apigen/apigen-engine-gateway/src/lib/gateway.ts:29, packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-passthrough-server.ts:11
- **Test-only importers:** apigen-cli (entrypoint/apigen-cli/src/test/integration/streaming.e2e.ts:26)
- **package.json dependents:** apigen-engine-conformance, apigen-engine-gateway, apigen-engine-runtime, apigen-plugin-api-express, apigen-plugin-api-fastify, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-logger, apigen-plugin-mcp, apigen-plugin-policy, policy-core-client, policy
- **Published:** public v0.2.3; npm last-month downloads 1281/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 26 commits total; 5 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 12 real importer(s) (+1 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-base-logical (packages/apigen/apigen-base-logical) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, (root/other:tools/vite-plugins), apigen-engine-conformance, apigen-core-client, apigen-engine-runtime, apigen-plugin-java-javalin, backlog. Reachable from entrypoint/root via apigen-cli > apigen-base-logical.
- **Importers (real import statements, non-test):** 7
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/commands/generate.ts:28
  - (root/other:tools/vite-plugins): tools/vite-plugins/externalize.mjs:24
  - @adhd/apigen-engine-conformance: packages/apigen/apigen-engine-conformance/src/lib/vectors.ts:666, packages/apigen/apigen-engine-conformance/src/lib/gate.ts:35
  - @adhd/apigen-core-client: packages/apigen/apigen-core-client/src/lib/compose-schemas.ts:1, packages/apigen/apigen-core-client/src/lib/compose-schemas.ts:2
  - @adhd/apigen-engine-runtime: packages/apigen/apigen-engine-runtime/src/lib/validate-layer.ts:44, packages/apigen/apigen-engine-runtime/src/lib/tool-description.ts:37
  - @adhd/apigen-plugin-java-javalin: packages/apigen/apigen-plugin-java-javalin/src/lib/dispatcher-template.ts:48
  - @adhd/backlog: entrypoint/backlog/src/cli-input-envelope.ts:29
- **Test-only importers:** (none)
- **package.json dependents:** apigen-core-client, apigen-engine-conformance, apigen-engine-runtime, apigen-plugin-java-javalin, apigen-cli, backlog
- **Published:** no publishConfig v0.1.4; npm last-month downloads 1631/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-25 b38aa0cd fix(apigen-base-logical): reject implicit union-branch matches the value cannot inhabit; 41 commits total; 24 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 7 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-base-schema (packages/apigen/apigen-base-schema) - WASTE (HIGH)

- **How it is wired:** No real import statement anywhere; tsconfig alias only.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.2.3; npm last-month downloads 598/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 28 commits total; 4 source files
- **Adversarial attack:** Its own header: "Currently a minimal package. The canonical type IR ... live in apigen-core-client and apigen-engine-runtime." It exports a 60-line `ApigenSchema` interface + one guard that nothing calls; the header even names it `@adhd/apigen-schema` (stale identity; backlog 805de7d5 "Correct the stale package identity constant").
- **Self-refutation:** Self-refutation: is it a planned home for schema utilities? No open backlog item names it as a dependency (only hygiene items 34eff6d1/805de7d5). Published as public 0.2.3, so it ships dead weight to npm. Refutation fails.
- **Evidence:** packages/apigen/apigen-base-schema/src/index.ts:1-10; tsconfig.base.json:70-72; `rg "ApigenSchema|__apigen_pkg" packages entrypoint` -> only core-client `ApigenSchemaHints` (unrelated symbol) and this package

### @adhd/apigen-base-types (packages/apigen/apigen-base-types) - WASTE (HIGH)

- **How it is wired:** No real import statement anywhere; only its own spec calls its single export.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** no publishConfig v0.1.3; npm last-month downloads 555/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 26 commits total; 5 source files
- **Adversarial attack:** Whole package is `apigenApigenBaseTypes(): string { return "apigen-apigen-base-types" }` (a generator placeholder) yet it is tagged pkg-kind:types and published (`access: public`, 0.1.3 in published-state).
- **Self-refutation:** Self-refutation: could a roadmap item or external consumer need it? Live backlog item 01e1c3c8 (open) already records "ships no types, has zero consumers"; no other open item names it; a stub has nothing consumable so npm downloads (555/mo = registry floor) cannot indicate use. Refutation fails.
- **Evidence:** packages/apigen/apigen-base-types/src/lib/apigen-apigen-base-types.ts:1-3; tsconfig.base.json:73-75 (alias only); `gx context apigenApigenBaseTypes` -> incoming: only apigen-apigen-base-types.spec.ts; backlog 01e1c3c8-b415-4fc6-bbc9-3fd7c7d68e11

### @adhd/apigen-core-client (packages/apigen/apigen-core-client) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: policy, apigen-cli, apigen-engine-conformance, apigen-plugin-py-grpc, apigen-codegen-openapi, backlog, apigen-plugin-api-fastify, apigen-plugin-openapi, apigen-plugin-ir-cache, apigen-plugin-logger, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-plugin-ts-types, apigen-plugin-py-flask, apigen-engine-runtime, apigen-plugin-health, apigen-plugin-api-express, apigen-engine-gateway, apigen-plugin-tracing, apigen-python-env, apigen-plugin-java-javalin, apigen-engine-naming, apigen-plugin-jsonschema. Reachable from entrypoint/root via apigen-cli > apigen-core-client.
- **Importers (real import statements, non-test):** 24
  - @adhd/policy: entrypoint/policy/src/wrapper/package.ts:3, entrypoint/policy/src/wrapper/prefix.ts:1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:22, entrypoint/apigen-cli/src/lib/commands/run.ts:7
  - @adhd/apigen-engine-conformance: packages/apigen/apigen-engine-conformance/src/lib/vectors.ts:16
  - @adhd/apigen-plugin-py-grpc: packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts:85
  - @adhd/apigen-codegen-openapi: packages/apigen/codegen/openapi/src/lib/to-openapi.ts:21
  - @adhd/backlog: entrypoint/backlog/src/server.ts:43, entrypoint/backlog/src/server.ts:78
  - @adhd/apigen-plugin-api-fastify: packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:9, packages/apigen/apigen-plugin-api-fastify/src/lib/generate.ts:5
  - @adhd/apigen-plugin-openapi: packages/apigen/apigen-plugin-openapi/src/lib/plugin.ts:22, packages/apigen/apigen-plugin-openapi/src/lib/plugin.ts:23
  - @adhd/apigen-plugin-ir-cache: packages/apigen/apigen-plugin-ir-cache/src/index.ts:46, packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts:75
  - @adhd/apigen-plugin-logger: packages/apigen/apigen-plugin-logger/src/lib/plugin.ts:11
  - @adhd/apigen-plugin-batch: packages/apigen/apigen-plugin-batch/src/lib/plugin.ts:33, packages/apigen/apigen-plugin-batch/src/lib/plugin.ts:34
  - @adhd/apigen-plugin-cli-output: packages/apigen/apigen-plugin-cli-output/src/lib/run.ts:7, packages/apigen/apigen-plugin-cli-output/src/lib/mount-cli-flags.ts:64
  - @adhd/apigen-plugin-mcp: packages/apigen/apigen-plugin-mcp/src/lib/run.ts:22, packages/apigen/apigen-plugin-mcp/src/lib/generate.ts:5
  - @adhd/apigen-plugin-ts-types: packages/apigen/apigen-plugin-ts-types/src/lib/emit-types.ts:15, packages/apigen/apigen-plugin-ts-types/src/lib/plugin.ts:9
  - @adhd/apigen-plugin-py-flask: packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts:78, packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts:79
  - @adhd/apigen-engine-runtime: packages/apigen/apigen-engine-runtime/src/lib/api-package.ts:1, packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts:39
  - @adhd/apigen-plugin-health: packages/apigen/apigen-plugin-health/src/lib/plugin.ts:26, packages/apigen/apigen-plugin-health/src/lib/plugin.ts:27
  - @adhd/apigen-plugin-api-express: packages/apigen/apigen-plugin-api-express/src/lib/run.ts:33, packages/apigen/apigen-plugin-api-express/src/lib/generate.ts:1
  - @adhd/apigen-engine-gateway: packages/apigen/apigen-engine-gateway/src/lib/gateway.ts:30, packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-source.ts:4
  - @adhd/apigen-plugin-tracing: packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts:5
  - @adhd/apigen-python-env: packages/apigen/python-env/src/lib/run-extractor.ts:23
  - @adhd/apigen-plugin-java-javalin: packages/apigen/apigen-plugin-java-javalin/src/lib/dispatcher-template.ts:47, packages/apigen/apigen-plugin-java-javalin/src/lib/plugin.ts:45
  - @adhd/apigen-engine-naming: packages/apigen/apigen-engine-naming/src/lib/naming.ts:14, packages/apigen/apigen-engine-naming/src/lib/naming.ts:15
  - @adhd/apigen-plugin-jsonschema: packages/apigen/apigen-plugin-jsonschema/src/lib/plugin.ts:5
- **Test-only importers:** (none)
- **package.json dependents:** apigen-engine-conformance, apigen-engine-gateway, apigen-engine-naming, apigen-engine-runtime, apigen-plugin-api-express, apigen-plugin-api-fastify, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-health, apigen-plugin-ir-cache, apigen-plugin-java-javalin, apigen-plugin-jsonschema, apigen-plugin-logger, apigen-plugin-mcp, apigen-plugin-openapi, apigen-plugin-py-flask, apigen-plugin-py-grpc, apigen-plugin-tracing, apigen-plugin-ts-types, apigen-codegen-openapi, apigen-python-env, apigen-cli, backlog, policy
- **Published:** public v0.3.4; npm last-month downloads 1829/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-14 0bf369d5 fix(apigen-plugin-ir-cache): extraction reports the files it read; cache keys the whole call and tracks installed-package deps; 95 commits total; 91 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 24 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-engine-conformance (packages/apigen/apigen-engine-conformance) - SHRINK (MEDIUM)

- **How it is wired:** Zero importers by design; it is a gate, run via its own `conformance`/`e2e` targets (project.json:21-67) and the CI Java-17 job (.github/workflows/ci.yml:39-47).
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.2.5; npm last-month downloads 565/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-28 45532731 fix(workspace): restore the publish gate's heavy lane and canonicalise the gate; 52 commits total; 10 source files
- **Adversarial attack:** Published as `access: public` although nothing can depend on a test-matrix runner; 10 source files whose consumers are CI only.
- **Self-refutation:** Self-refutation: it is the live JVM/Python conformance gate, so deleting it would remove real cross-host verification (KEEP the code). The waste is only in publishing it.
- **Evidence:** packages/apigen/apigen-engine-conformance/project.json:21,43,67; .github/workflows/ci.yml:39-47; src/lib/gate.ts:497

### @adhd/apigen-engine-gateway (packages/apigen/apigen-engine-gateway) - KEEP (LOW)

- **How it is wired:** Single prod importer: entrypoint/policy (and apigen-cli tests).
- **Importers (real import statements, non-test):** 1
  - @adhd/policy: entrypoint/policy/src/wrapper/verbs/run.ts:2, entrypoint/policy/src/wrapper/verbs/deps.ts:1
- **Test-only importers:** apigen-cli (entrypoint/apigen-cli/src/test/integration/gateway-mixed-host.e2e.ts:38)
- **package.json dependents:** policy
- **Published:** public v0.2.3; npm last-month downloads 628/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-14 5087ba97 test(apigen-engine-gateway): track the win32 process-group skips with backlog 05f910a0; 46 commits total; 26 source files
- **Adversarial attack:** One consumer.
- **Self-refutation:** Refuted: it is the live gateway under the policy host; ties to an actively developed entrypoint (policy 0.0.1, commits 2026-10-14).
- **Evidence:** entrypoint/policy (see importers below)

### @adhd/apigen-engine-naming (packages/apigen/apigen-engine-naming) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: policy, apigen-cli, apigen-engine-conformance, apigen-plugin-py-grpc, apigen-codegen-openapi, backlog, apigen-plugin-api-fastify, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-plugin-ts-types, apigen-plugin-py-flask, apigen-engine-runtime, apigen-plugin-api-express, apigen-plugin-java-javalin. Reachable from entrypoint/root via apigen-cli > apigen-engine-naming.
- **Importers (real import statements, non-test):** 14
  - @adhd/policy: entrypoint/policy/src/wrapper/prefix.ts:2
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/orchestrator.ts:51, entrypoint/apigen-cli/src/lib/orchestrator.ts:52
  - @adhd/apigen-engine-conformance: packages/apigen/apigen-engine-conformance/src/lib/vectors.ts:25
  - @adhd/apigen-plugin-py-grpc: packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts:87
  - @adhd/apigen-codegen-openapi: packages/apigen/codegen/openapi/src/lib/to-openapi.ts:20
  - @adhd/backlog: entrypoint/backlog/src/server.ts:44, entrypoint/backlog/src/server.ts:45
  - @adhd/apigen-plugin-api-fastify: packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:10, packages/apigen/apigen-plugin-api-fastify/src/lib/generate.ts:12
  - @adhd/apigen-plugin-cli-output: packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts:3, packages/apigen/apigen-plugin-cli-output/src/lib/schema-introspect.ts:1
  - @adhd/apigen-plugin-mcp: packages/apigen/apigen-plugin-mcp/src/lib/run.ts:23, packages/apigen/apigen-plugin-mcp/src/lib/tool-naming.ts:28
  - @adhd/apigen-plugin-ts-types: packages/apigen/apigen-plugin-ts-types/src/lib/emit-types.ts:16
  - @adhd/apigen-plugin-py-flask: packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts:81
  - @adhd/apigen-engine-runtime: packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts:44, packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts:48
  - @adhd/apigen-plugin-api-express: packages/apigen/apigen-plugin-api-express/src/lib/run.ts:36, packages/apigen/apigen-plugin-api-express/src/lib/generate.ts:8
  - @adhd/apigen-plugin-java-javalin: packages/apigen/apigen-plugin-java-javalin/src/lib/plugin.ts:46
- **Test-only importers:** (none)
- **package.json dependents:** apigen-engine-conformance, apigen-engine-runtime, apigen-plugin-api-express, apigen-plugin-api-fastify, apigen-plugin-cli-output, apigen-plugin-java-javalin, apigen-plugin-mcp, apigen-plugin-py-flask, apigen-plugin-py-grpc, apigen-plugin-ts-types, apigen-codegen-openapi, apigen-cli, backlog, policy
- **Published:** public v0.2.5; npm last-month downloads 1372/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-25 ad52ba61 fix(apigen-engine-naming): close review doc/lint residuals; 42 commits total; 7 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 14 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-engine-runtime (packages/apigen/apigen-engine-runtime) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, policy, apigen-plugin-api-fastify, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-plugin-py-flask, apigen-plugin-policy, apigen-plugin-api-express, apigen-engine-gateway. Reachable from entrypoint/root via apigen-cli > apigen-engine-runtime.
- **Importers (real import statements, non-test):** 10
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/logging.ts:2, entrypoint/apigen-cli/src/lib/logging.ts:3
  - @adhd/policy: entrypoint/policy/src/wrapper/attributes-layer.ts:2, entrypoint/policy/src/wrapper/gate.ts:2
  - @adhd/apigen-plugin-api-fastify: packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:21, packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:35
  - @adhd/apigen-plugin-batch: packages/apigen/apigen-plugin-batch/src/lib/plugin.ts:40, packages/apigen/apigen-plugin-batch/src/lib/plugin.ts:41
  - @adhd/apigen-plugin-cli-output: packages/apigen/apigen-plugin-cli-output/src/lib/run.ts:18, packages/apigen/apigen-plugin-cli-output/src/lib/run.ts:30
  - @adhd/apigen-plugin-mcp: packages/apigen/apigen-plugin-mcp/src/lib/run.ts:34, packages/apigen/apigen-plugin-mcp/src/lib/run.ts:49
  - @adhd/apigen-plugin-py-flask: packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts:82
  - @adhd/apigen-plugin-policy: packages/apigen/apigen-plugin-policy/src/plugin.ts:2
  - @adhd/apigen-plugin-api-express: packages/apigen/apigen-plugin-api-express/src/lib/run.ts:16, packages/apigen/apigen-plugin-api-express/src/lib/run.ts:27
  - @adhd/apigen-engine-gateway: packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-passthrough-server.ts:12, packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-passthrough-server.ts:13
- **Test-only importers:** apigen-plugin-py-grpc (packages/apigen/apigen-plugin-py-grpc/src/test/plugin.e2e.ts:69), backlog (entrypoint/backlog/src/query-output-codec.spec.ts:40)
- **package.json dependents:** apigen-engine-gateway, apigen-plugin-api-express, apigen-plugin-api-fastify, apigen-plugin-batch, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-plugin-policy, apigen-plugin-py-flask, apigen-cli, policy
- **Published:** public v0.3.3; npm last-month downloads 1555/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-08 c079e826 fix(agent-mcp): bind loopback 127.0.0.1 by default; apigen hosts and generated servers too (5989ed90); 87 commits total; 60 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 10 real importer(s) (+2 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-generator-nx (packages/apigen/apigen-generator-nx) - KEEP (HIGH)

- **How it is wired:** executor @adhd/apigen-generator-nx:generate at entrypoint/dispatch-cli/project.json:39
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.1.6; npm last-month downloads 953/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 31 commits total; 11 source files
- **Adversarial attack:** Zero import statements.
- **Self-refutation:** Refuted: dispatch-cli build uses its `generate` executor; apigen-cli README:438-440 documents its generators.
- **Evidence:** entrypoint/dispatch-cli/project.json:39

### @adhd/apigen-plugin-api-express (packages/apigen/apigen-plugin-api-express) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-api-express.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:14
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli
- **Published:** public v0.2.8; npm last-month downloads 1107/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-09 0fbf9a66 chore(deps): dedupe @adhd/sox-telemetry to ^0.4.3 across consumers and regenerate lockfile (c536ce29); 61 commits total; 17 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-api-fastify (packages/apigen/apigen-plugin-api-fastify) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, policy, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-api-fastify.
- **Importers (real import statements, non-test):** 3
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:13
  - @adhd/policy: entrypoint/policy/src/wrapper/mount.ts:5
  - @adhd/backlog: entrypoint/backlog/src/server.ts:46
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli, backlog, policy
- **Published:** public v0.2.8; npm last-month downloads 1265/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-09 0fbf9a66 chore(deps): dedupe @adhd/sox-telemetry to ^0.4.3 across consumers and regenerate lockfile (c536ce29); 64 commits total; 17 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-batch (packages/apigen/apigen-plugin-batch) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-batch.
- **Importers (real import statements, non-test):** 2
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/commands/run.ts:31
  - @adhd/backlog: entrypoint/backlog/src/server.ts:49, entrypoint/backlog/src/cli.ts:27
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli, backlog
- **Published:** public v0.2.6; npm last-month downloads 1017/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-01 509ee4c7 fix(apigen): engine-supplied Call.transport + real-transport tracing e2e; 23 commits total; 5 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 2 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-cli-output (packages/apigen/apigen-plugin-cli-output) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, policy, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-cli-output.
- **Importers (real import statements, non-test):** 3
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:15
  - @adhd/policy: entrypoint/policy/src/wrapper/mount.ts:6
  - @adhd/backlog: entrypoint/backlog/src/cli.ts:26
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli, backlog, policy
- **Published:** public v0.2.8; npm last-month downloads 1340/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-09 0fbf9a66 chore(deps): dedupe @adhd/sox-telemetry to ^0.4.3 across consumers and regenerate lockfile (c536ce29); 66 commits total; 22 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-health (packages/apigen/apigen-plugin-health) - KEEP (MEDIUM)

- **How it is wired:** apigen-cli imports it; tests in express/fastify hosts exercise it.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/commands/run.ts:28, entrypoint/apigen-cli/src/lib/commands/run.ts:32
- **Test-only importers:** apigen-plugin-api-fastify (packages/apigen/apigen-plugin-api-fastify/src/test/plugin.e2e.ts:5), apigen-plugin-api-express (packages/apigen/apigen-plugin-api-express/src/test/plugin.e2e.ts:5)
- **package.json dependents:** apigen-cli
- **Published:** public v0.2.6; npm last-month downloads 956/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-08 c079e826 fix(agent-mcp): bind loopback 127.0.0.1 by default; apigen hosts and generated servers too (5989ed90); 41 commits total; 5 source files
- **Adversarial attack:** 5 files, one real consumer.
- **Self-refutation:** Refuted: thin by design (plugin per concern); consumed.
- **Evidence:** importers below

### @adhd/apigen-plugin-ir-cache (packages/apigen/apigen-plugin-ir-cache) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-ir-cache.
- **Importers (real import statements, non-test):** 2
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:18, entrypoint/apigen-cli/src/index.ts:19
  - @adhd/backlog: entrypoint/backlog/src/ir-artifact.ts:50, entrypoint/backlog/src/extract-live.ts:30
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli, backlog
- **Published:** public v0.1.4; npm last-month downloads 1051/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-14 0bf369d5 fix(apigen-plugin-ir-cache): extraction reports the files it read; cache keys the whole call and tracks installed-package deps; 27 commits total; 15 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 2 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-java-javalin (packages/apigen/apigen-plugin-java-javalin) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-java-javalin.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:20
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli
- **Published:** public v0.0.4; npm last-month downloads 801/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-28 45532731 fix(workspace): restore the publish gate's heavy lane and canonicalise the gate; 27 commits total; 11 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-jsonschema (packages/apigen/apigen-plugin-jsonschema) - KEEP (MEDIUM)

- **How it is wired:** apigen-cli imports it.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:11
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli
- **Published:** public v0.2.3; npm last-month downloads 722/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 5cef1867 refactor(nx): infer release-publish + lint targets; make lint check-only; 36 commits total; 5 source files
- **Adversarial attack:** 5 files, one consumer, description overlaps apigen-codegen-openapi/ts-types.
- **Self-refutation:** Refuted: imported by the flagship apigen host; emits a distinct artifact.
- **Evidence:** importers below

### @adhd/apigen-plugin-logger (packages/apigen/apigen-plugin-logger) - KEEP (MEDIUM)

- **How it is wired:** apigen-cli and (via cli-output) the chain import it.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/commands/run.ts:33
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli
- **Published:** public v0.2.3; npm last-month downloads 734/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 5cef1867 refactor(nx): infer release-publish + lint targets; make lint check-only; 38 commits total; 5 source files
- **Adversarial attack:** 5 files.
- **Self-refutation:** Refuted: consumed.
- **Evidence:** importers below

### @adhd/apigen-plugin-mcp (packages/apigen/apigen-plugin-mcp) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, policy, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-mcp.
- **Importers (real import statements, non-test):** 3
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:10
  - @adhd/policy: entrypoint/policy/src/wrapper/mount.ts:7
  - @adhd/backlog: entrypoint/backlog/src/server.ts:48
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli, backlog, policy
- **Published:** public v0.3.3; npm last-month downloads 1340/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-09 0fbf9a66 chore(deps): dedupe @adhd/sox-telemetry to ^0.4.3 across consumers and regenerate lockfile (c536ce29); 66 commits total; 24 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-openapi (packages/apigen/apigen-plugin-openapi) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-openapi.
- **Importers (real import statements, non-test):** 2
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/commands/run.ts:34
  - @adhd/backlog: entrypoint/backlog/src/server.ts:47
- **Test-only importers:** apigen-plugin-api-fastify (packages/apigen/apigen-plugin-api-fastify/src/test/plugin.e2e.ts:6), apigen-plugin-api-express (packages/apigen/apigen-plugin-api-express/src/test/plugin.e2e.ts:6)
- **package.json dependents:** apigen-cli, backlog
- **Published:** public v0.2.5; npm last-month downloads 912/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 5cef1867 refactor(nx): infer release-publish + lint targets; make lint check-only; 41 commits total; 5 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 2 real importer(s) (+2 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-policy (packages/apigen/apigen-plugin-policy) - KEEP (MEDIUM)

- **How it is wired:** entrypoint/policy imports it; not on npm yet (0.0.1, `not found`).
- **Importers (real import statements, non-test):** 1
  - @adhd/policy: entrypoint/policy/src/wrapper/gate.ts:3
- **Test-only importers:** (none)
- **package.json dependents:** policy
- **Published:** no publishConfig v0.0.1; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-10-14 9e6badda test(policy): add test headers (guards, tier, cites); 9 commits total; 11 source files
- **Adversarial attack:** 9 commits total, brand-new.
- **Self-refutation:** Refuted: wired into the new policy entrypoint.
- **Evidence:** importers below

### @adhd/apigen-plugin-py-flask (packages/apigen/apigen-plugin-py-flask) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-py-flask.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:16
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli
- **Published:** public v0.2.8; npm last-month downloads 933/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-28 45532731 fix(workspace): restore the publish gate's heavy lane and canonicalise the gate; 56 commits total; 7 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-py-grpc (packages/apigen/apigen-plugin-py-grpc) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-cli. Reachable from entrypoint/root via apigen-cli > apigen-plugin-py-grpc.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:17
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli
- **Published:** public v0.2.7; npm last-month downloads 724/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-28 45532731 fix(workspace): restore the publish gate's heavy lane and canonicalise the gate; 51 commits total; 7 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-tracing (packages/apigen/apigen-plugin-tracing) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: policy, apigen-cli, backlog. Reachable from entrypoint/root via apigen-cli > apigen-plugin-tracing.
- **Importers (real import statements, non-test):** 3
  - @adhd/policy: entrypoint/policy/src/wrapper/tracing.ts:1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/commands/run.ts:41
  - @adhd/backlog: entrypoint/backlog/src/tracing.ts:1
- **Test-only importers:** apigen-plugin-api-fastify (packages/apigen/apigen-plugin-api-fastify/src/test/tracing-transport.e2e.ts:8), apigen-plugin-mcp (packages/apigen/apigen-plugin-mcp/src/test/tracing-transport.e2e.ts:10), apigen-plugin-cli-output (packages/apigen/apigen-plugin-cli-output/src/test/tracing-transport.e2e.ts:7), apigen-plugin-api-express (packages/apigen/apigen-plugin-api-express/src/test/tracing-transport.e2e.ts:8)
- **package.json dependents:** apigen-plugin-api-express, apigen-plugin-api-fastify, apigen-plugin-cli-output, apigen-plugin-mcp, apigen-cli, backlog, policy
- **Published:** public v0.2.0; npm last-month downloads 573/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-09 0fbf9a66 chore(deps): dedupe @adhd/sox-telemetry to ^0.4.3 across consumers and regenerate lockfile (c536ce29); 12 commits total; 5 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s) (+4 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-plugin-ts-types (packages/apigen/apigen-plugin-ts-types) - KEEP (MEDIUM)

- **How it is wired:** apigen-cli imports it.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/index.ts:12
- **Test-only importers:** (none)
- **package.json dependents:** apigen-cli
- **Published:** no publishConfig v0.0.3; npm last-month downloads 575/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 5cef1867 refactor(nx): infer release-publish + lint targets; make lint check-only; 16 commits total; 6 source files
- **Adversarial attack:** 5-6 files, one consumer, no description.
- **Self-refutation:** Refuted: imported by the flagship apigen host.
- **Evidence:** importers below

### @adhd/apigen-codegen-openapi (packages/apigen/codegen/openapi) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: apigen-plugin-openapi. Reachable from entrypoint/root via apigen-cli > apigen-plugin-openapi > apigen-codegen-openapi.
- **Importers (real import statements, non-test):** 1
  - @adhd/apigen-plugin-openapi: packages/apigen/apigen-plugin-openapi/src/lib/plugin.ts:24
- **Test-only importers:** apigen-plugin-api-fastify (packages/apigen/apigen-plugin-api-fastify/src/test/plugin.e2e.ts:13)
- **package.json dependents:** apigen-plugin-openapi
- **Published:** public v0.2.5; npm last-month downloads 923/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 36 commits total; 5 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s) (+1 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/apigen-python-env (packages/apigen/python-env) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: apigen-cli, apigen-engine-conformance, apigen-plugin-py-grpc, apigen-plugin-py-flask. Reachable from entrypoint/root via apigen-cli > apigen-python-env.
- **Importers (real import statements, non-test):** 4
  - @adhd/apigen-cli: entrypoint/apigen-cli/src/lib/commands/serve.ts:78
  - @adhd/apigen-engine-conformance: packages/apigen/apigen-engine-conformance/src/lib/gate.ts:23
  - @adhd/apigen-plugin-py-grpc: packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts:86
  - @adhd/apigen-plugin-py-flask: packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts:80
- **Test-only importers:** (none)
- **package.json dependents:** apigen-engine-conformance, apigen-plugin-py-flask, apigen-plugin-py-grpc, apigen-cli
- **Published:** public v0.2.7; npm last-month downloads 836/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-28 45532731 fix(workspace): restore the publish gate's heavy lane and canonicalise the gate; 47 commits total; 9 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 4 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/data-base-transforms (packages/data/data-base-transforms) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: data-query-engine, data-core-structures, decompile-cli. Reachable from entrypoint/root via decompile-cli > data-base-transforms.
- **Importers (real import statements, non-test):** 3
  - @adhd/data-query-engine: packages/data/data-query-engine/src/lib/query.ts:1, packages/data/data-query-engine/src/lib/path.ts:1
  - @adhd/data-core-structures: packages/data/data-core-structures/src/lib/geolocation.ts:4
  - @adhd/decompile-cli: entrypoint/decompile-cli/src/lib/store/index.ts:1, entrypoint/decompile-cli/src/lib/extractors/index.ts:1
- **Test-only importers:** (none)
- **package.json dependents:** data-core-structures, data-query-engine, decompile-cli
- **Published:** public v2.3.4; npm last-month downloads 797/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-14 4f88f6c9 test(data-base-transforms): drop dead commented-out legacy blocks from specs; record qa legacy-test audit; 33 commits total; 23 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/data-core-structures (packages/data/data-core-structures) - MERGE (LOW)

- **How it is wired:** Only data-query-engine imports it (src/lib/model/indexing.ts:11: BPlusTree, PostingIndex, RoaringBitmap).
- **Importers (real import statements, non-test):** 1
  - @adhd/data-query-engine: packages/data/data-query-engine/src/lib/model/indexing.ts:11
- **Test-only importers:** (none)
- **package.json dependents:** data-query-engine
- **Published:** public v2.3.4; npm last-month downloads 653/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-06 ae07b40b fix(data-query-engine,data-core-structures): clear 5 test-audit findings; 35 commits total; 20 source files
- **Adversarial attack:** 20 files published as its own package with exactly one consumer in the whole repo.
- **Self-refutation:** Self-refutation: standalone B+tree/roaring bitmap may be intended for external reuse (published public, 653/mo floor, UNKNOWN). Merge is optional; LOW confidence.
- **Evidence:** packages/data/data-query-engine/src/lib/model/indexing.ts:11

### @adhd/data-query-engine (packages/data/data-query-engine) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: policy-core-client. Reachable from entrypoint/root via policy > policy-core-client > data-query-engine.
- **Importers (real import statements, non-test):** 1
  - @adhd/policy-core-client: packages/policy/policy-core-client/src/core/engine/query.ts:1, packages/policy/policy-core-client/src/core/engine/query.ts:2
- **Test-only importers:** (none)
- **package.json dependents:** policy-core-client
- **Published:** public v2.3.10; npm last-month downloads 1502/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 228ff974 build(vitest): measured pool defaults (forks, no poolOptions/vm), backlog file parallelism, engine-runtime no-isolate; shrink data-query-engine complexity ladder; PIPELINE docs; 65 commits total; 40 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/dispatch-base-spec (packages/dispatch/dispatch-base-spec) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: dispatch-cli, dispatch-core-client, dispatch-serializer-json, dispatch-orchestrator, dispatch-core-optimizer. Reachable from entrypoint/root via dispatch-cli > dispatch-base-spec.
- **Importers (real import statements, non-test):** 5
  - @adhd/dispatch-cli: entrypoint/dispatch-cli/src/lib/core.ts:42, entrypoint/dispatch-cli/src/lib/core.ts:43
  - @adhd/dispatch-core-client: packages/dispatch/dispatch-core-client/src/lib/client.ts:8, packages/dispatch/dispatch-core-client/src/lib/serializer.ts:1
  - @adhd/dispatch-serializer-json: packages/dispatch/dispatch-serializer-json/src/index.ts:3, packages/dispatch/dispatch-serializer-json/src/index.ts:4
  - @adhd/dispatch-orchestrator: packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:3, packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:53
  - @adhd/dispatch-core-optimizer: packages/dispatch/dispatch-core-optimizer/src/lib/optimize.ts:37, packages/dispatch/dispatch-core-optimizer/src/lib/index.ts:7
- **Test-only importers:** (none)
- **package.json dependents:** dispatch-core-client, dispatch-core-optimizer, dispatch-orchestrator, dispatch-serializer-json, dispatch-cli
- **Published:** public v0.1.7; npm last-month downloads 1043/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 4e465788 Committing: released items; 51 commits total; 11 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 5 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/dispatch-base-types (packages/dispatch/dispatch-base-types) - WASTE (HIGH)

- **How it is wired:** No real import statement anywhere; tsconfig alias only.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** no publishConfig v0.1.3; npm last-month downloads 570/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 23 commits total; 5 source files
- **Adversarial attack:** Identical generator stub (`dispatchDispatchBaseTypes()` returns its own name). The real dispatch contracts live in dispatch-base-spec (5 prod importers).
- **Self-refutation:** Self-refutation: open backlog 70e61986 ("Build the dispatch-tools package") is a different package and 881ff6e5 is a metadata-hygiene sweep, neither depends on it. Refutation fails.
- **Evidence:** packages/dispatch/dispatch-base-types/src/lib/dispatch-dispatch-base-types.ts:1-3; tsconfig.base.json:167-169; `rg "@adhd/dispatch-base-types"` in code/config outside own dir -> no hits

### @adhd/dispatch-core-client (packages/dispatch/dispatch-core-client) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: dispatch-cli, dispatch-serializer-json, dispatch-orchestrator. Reachable from entrypoint/root via dispatch-cli > dispatch-core-client.
- **Importers (real import statements, non-test):** 3
  - @adhd/dispatch-cli: entrypoint/dispatch-cli/src/lib/core.ts:44
  - @adhd/dispatch-serializer-json: packages/dispatch/dispatch-serializer-json/src/index.ts:5
  - @adhd/dispatch-orchestrator: packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:54
- **Test-only importers:** (none)
- **package.json dependents:** dispatch-orchestrator, dispatch-serializer-json, dispatch-cli
- **Published:** public v0.1.3; npm last-month downloads 763/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 4e465788 Committing: released items; 33 commits total; 7 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/dispatch-core-optimizer (packages/dispatch/dispatch-core-optimizer) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: dispatch-cli. Reachable from entrypoint/root via dispatch-cli > dispatch-core-optimizer.
- **Importers (real import statements, non-test):** 1
  - @adhd/dispatch-cli: entrypoint/dispatch-cli/src/lib/core.ts:49
- **Test-only importers:** dispatch-orchestrator (packages/dispatch/dispatch-orchestrator/src/test/hitl-suspension.spec.ts:46)
- **package.json dependents:** dispatch-orchestrator, dispatch-cli
- **Published:** no publishConfig v0.1.7; npm last-month downloads 883/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 4e465788 Committing: released items; 41 commits total; 12 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s) (+1 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/dispatch-orchestrator (packages/dispatch/dispatch-orchestrator) - KEEP (MEDIUM)

- **How it is wired:** Real import statements (non-test) from: dispatch-cli. Reachable from entrypoint/root via dispatch-cli > dispatch-orchestrator.
- **Importers (real import statements, non-test):** 1
  - @adhd/dispatch-cli: entrypoint/dispatch-cli/src/lib/core.ts:65, entrypoint/dispatch-cli/src/api.ts:32
- **Test-only importers:** (none)
- **package.json dependents:** dispatch-cli
- **Published:** public v0.1.7; npm last-month downloads 918/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-08 cfc9d936 feat(agent-engine-orchestrator): capture provider response model; build usage test fixtures from real migrations (1f1c8598); 82 commits total; 22 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 1 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/dispatch-serializer-json (packages/dispatch/dispatch-serializer-json) - MERGE (LOW)

- **How it is wired:** dispatch-cli imports it (real import); dispatch-orchestrator test-only.
- **Importers (real import statements, non-test):** 1
  - @adhd/dispatch-cli: entrypoint/dispatch-cli/src/lib/core.ts:45
- **Test-only importers:** dispatch-orchestrator (packages/dispatch/dispatch-orchestrator/src/test/hitl-suspension.spec.ts:45)
- **package.json dependents:** dispatch-orchestrator, dispatch-cli
- **Published:** public v0.1.4; npm last-month downloads 865/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 4e465788 Committing: released items; 33 commits total; 4 source files
- **Adversarial attack:** 4 files, one consumer, tiny: (de)serialises the DAG spec that dispatch-core-client already owns.
- **Self-refutation:** Self-refutation: separating serializers keeps core-client format-agnostic. It is a legitimate seam, only a tidiness MERGE; LOW confidence.
- **Evidence:** see per-package importers below

### @adhd/environment-base-spec (packages/environment/environment-base-spec) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: policy-core-client, agent-mcp, environment-builder, environment-cli, environment, backlog. Reachable from entrypoint/root via agent-mcp > environment-base-spec.
- **Importers (real import statements, non-test):** 6
  - @adhd/policy-core-client: packages/policy/policy-core-client/src/service/config/env-spec.ts:2
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/config-store-path.ts:25, entrypoint/agent-mcp/src/config.ts:24
  - @adhd/environment-builder: packages/environment/environment-builder/src/layer-files.ts:14, packages/environment/environment-builder/src/dirs.ts:15
  - @adhd/environment-cli: entrypoint/environment-cli/src/core.ts:26, entrypoint/environment-cli/src/core.ts:27
  - @adhd/environment: packages/environment/environment-core-node/src/index.ts:26, packages/environment/environment-core-node/src/environment.ts:31
  - @adhd/backlog: entrypoint/backlog/src/server.ts:37, entrypoint/backlog/src/env.ts:13
- **Test-only importers:** (none)
- **package.json dependents:** environment-builder, environment, policy-core-client, agent-mcp, backlog, environment-cli
- **Published:** no publishConfig v0.1.4; npm last-month downloads 1362/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-06 f285def5 merge(agent): shell-pattern allowlist (ALLOW_PATTERNS) into native-tooling integration; 33 commits total; 5 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 6 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/environment-builder (packages/environment/environment-builder) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: environment-cli, environment, backlog. Reachable from entrypoint/root via backlog > environment-builder.
- **Importers (real import statements, non-test):** 3
  - @adhd/environment-cli: entrypoint/environment-cli/src/core.ts:36
  - @adhd/environment: packages/environment/environment-core-node/src/environment.ts:39
  - @adhd/backlog: entrypoint/backlog/src/service-config.ts:31, entrypoint/backlog/src/write/embedding-config.ts:53
- **Test-only importers:** (none)
- **package.json dependents:** environment, backlog, environment-cli
- **Published:** no publishConfig v0.1.7; npm last-month downloads 1185/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-25 796a3cc4 fix(environment-cli): default-import yaml so emitted ESM loads, and gate it; 35 commits total; 21 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 3 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/environment (packages/environment/environment-core-node) - KEEP (HIGH)

- **How it is wired:** Real import statements (non-test) from: policy-core-client, agent-mcp, environment-cli, apigen-plugin-ir-cache, agent-core-env, backlog. Reachable from entrypoint/root via agent-mcp > environment.
- **Importers (real import statements, non-test):** 6
  - @adhd/policy-core-client: packages/policy/policy-core-client/src/service/config/env-spec.ts:1
  - @adhd/agent-mcp: entrypoint/agent-mcp/src/config.ts:23
  - @adhd/environment-cli: entrypoint/environment-cli/src/core.ts:441
  - @adhd/apigen-plugin-ir-cache: packages/apigen/apigen-plugin-ir-cache/src/lib/default-cache-file.ts:38
  - @adhd/agent-core-env: packages/agent/agent-core-env/src/spec.ts:26, packages/agent/agent-core-env/src/resolve-registry-db-path.ts:12
  - @adhd/backlog: entrypoint/backlog/src/env.ts:8, entrypoint/backlog/src/api.ts:49
- **Test-only importers:** apigen-core-client (packages/apigen/apigen-core-client/src/test/extraction-session.e2e.ts:267)
- **package.json dependents:** agent-core-env, apigen-plugin-ir-cache, policy-core-client, agent-mcp, backlog
- **Published:** no publishConfig v0.1.8; npm last-month downloads 1168/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 35 commits total; 11 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 6 real importer(s) (+1 test-only).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/policy-core-client (packages/policy/policy-core-client) - KEEP (MEDIUM)

- **How it is wired:** entrypoint/policy imports it; it imports data-query-engine and environment.
- **Importers (real import statements, non-test):** 1
  - @adhd/policy: entrypoint/policy/src/wrapper/package.ts:4, entrypoint/policy/src/wrapper/attributes-source.ts:4
- **Test-only importers:** apigen-plugin-policy (packages/apigen/apigen-plugin-policy/src/test/helpers/policies.ts:1)
- **package.json dependents:** policy
- **Published:** no publishConfig v0.0.1; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-10-14 9e6badda test(policy): add test headers (guards, tier, cites); 15 commits total; 60 source files
- **Adversarial attack:** Brand-new (15 commits, unpublished) and conceptually overlaps agent-core-policy.
- **Self-refutation:** Refuted: the sole consumer of data-query-engine and the engine of the policy entrypoint.
- **Evidence:** importers below

### @adhd/ui-react-base-hooks (packages/ui-react/ui-react-base-hooks) - SHRINK (LOW)

- **How it is wired:** Zero importers. Repo has no React app or component library; sole React surface (docs/ARCHITECTURE.md:65 "Dashboard components").
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v2.3.5; npm last-month downloads 623/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-25 2e9146f0 fix(test): make the full affected gate green (3 latent test-hermeticity fixes); 34 commits total; 35 source files
- **Adversarial attack:** 35 files of generic hooks (use-debounce, use-infinite-scroll, use-copy-to-clipboard...) that duplicate off-the-shelf hook libraries and have no caller in this repo. It drags React 19, storybook 7, material-tailwind, cypress, next plugins into the root devDependencies (package.json:33,59,89,91,97).
- **Self-refutation:** Self-refutation: open backlog b702f0fb (MEDIUM) specifies a React filter panel for data-query-engine and names this package as the existing React surface; it proposes a NEW package (`ui-react-filter-panel`) and has provenance "wrong-chat-spec-captured". That is a weak roadmap tie, so not WASTE; the verdict is SHRINK. If b702f0fb is dropped this becomes WASTE. External consumers UNKNOWN (623/mo = floor).
- **Evidence:** packages/ui-react/ui-react-base-hooks/src/lib/*; docs/ARCHITECTURE.md:65; backlog b702f0fb-6e5f-48a4-a587-76e320001e89; package.json:33,59,89,91,97

### @adhd/ui-react-base-storybook (packages/ui-react/ui-react-base-storybook) - MERGE (MEDIUM)

- **How it is wired:** Private; zero importers; wired only by root script `storybook` (package.json:18) and nx.json:273 exclusion.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.1; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 14 commits total; 5 source files
- **Adversarial attack:** Its only component is the scaffold placeholder `<h1>Welcome to Storybook!</h1>`. The real content is its `.storybook/main.ts` glob that serves ui-react-base-hooks stories.
- **Self-refutation:** Self-refutation: the Storybook host is genuinely used to view hooks stories. So the config is worth keeping but as a folder inside ui-react-base-hooks, not a package with a placeholder component. Falls with hooks if hooks go.
- **Evidence:** packages/ui-react/ui-react-base-storybook/src/lib/storybook.tsx:1-12; .storybook/main.ts (stories glob ../../**/src/lib/**/*.stories.*); package.json:18; backlog 5-item grep: no roadmap item

### @adhd/workspace-base-standard (packages/workspace/workspace-base-standard) - SHRINK (MEDIUM)

- **How it is wired:** Zero importers; its README/PLAYBOOK say it is a core awaiting a consumer (`PKG-WS-NX-ADAPTER`) that has never landed.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** no publishConfig v0.0.4; npm last-month downloads 558/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 5cef1867 refactor(nx): infer release-publish + lint targets; make lint check-only; 15 commits total; 15 source files
- **Adversarial attack:** 15 source files + spec corpus of checkers for a standard that no code enforces. PLAYBOOK.md: "nothing should import @adhd/workspace-base-standard yet". The consumer item has no live backlog node (query for PKG-WS-NX-ADAPTER returns 0).
- **Self-refutation:** Self-refutation: roadmap exists in the grooming extract: FEAT-CHANGE-ENFORCE-001 "real, still-open, ~0%-implemented gap" (live graph node 037019f1, status UNKNOWN, priority HIGH, titled workspace-standards base generator + custom workspace lint). So NOT WASTE under the rule; but it is speculative inventory published to npm, so SHRINK (stop publishing until the adapter exists).
- **Evidence:** packages/workspace/workspace-base-standard/PLAYBOOK.md:18; src/required.ts:4; docs/backlog/grooming/wf_28c6a91a-4c9-extract.json:6867-6879; backlog 037019f1-07d5-4634-81bb-340e267b37cb

### @adhd/workspace-base-tools (packages/workspace/workspace-base-tools) - WASTE (MEDIUM)

- **How it is wired:** No real import statement anywhere. Wired only in nx.json:141 (tsc build include) and tsconfig.base.json:202.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** no publishConfig v0.1.3; npm last-month downloads 613/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 b2022986 feat(vite-plugins): absorb perf/test-resolve-fix — test-time @adhd/* source resolution; 29 commits total; 7 source files
- **Adversarial attack:** Exports one function `getPackageInfo()` (walk up from cwd to the nearest package.json) plus a generator stub `workspaceWorkspaceBaseTools()`. `gx context getPackageInfo` shows its only caller is its own spec. Its sole open backlog items are a stale @nx/devkit pin (b3bd926e) and a metadata sweep.
- **Self-refutation:** Self-refutation: it is a plausible primitive for generators/executors. But workspace-codegen-nx and the nx-* plugins compute package info themselves and do not import it. MEDIUM not HIGH because an external npm consumer is UNKNOWN (downloads at registry floor, 613/mo, prove nothing).
- **Evidence:** packages/workspace/workspace-base-tools/src/get-package-info.ts:1-30; src/index.ts:1-3; nx.json:141; `gx context getPackageInfo` -> callers: get-package-info.spec.ts; backlog b3bd926e-d8fd-45e4-ae8d-714859768aec

### @adhd/workspace-base-vite-paths (packages/workspace/workspace-base-vite-paths) - KEEP (MEDIUM)

- **How it is wired:** Imported by relative path (not by package name) from entrypoint/agent-mcp/vite.config.ts:7 and entrypoint/policy/vite.config.ts:6; nx.json:44 namedInput.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** no publishConfig v0.0.4; npm last-month downloads 401/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-22 5cef1867 refactor(nx): infer release-publish + lint targets; make lint check-only; 14 commits total; 5 source files
- **Adversarial attack:** Zero import statements by package name; the relative import violates AGENTS.md section 9 import rule.
- **Self-refutation:** Refuted: build-time config helper that several vite configs really execute.
- **Evidence:** entrypoint/agent-mcp/vite.config.ts:7; entrypoint/policy/vite.config.ts:6; nx.json:44

### @adhd/workspace-codegen-nx (packages/workspace/workspace-codegen-nx) - KEEP (MEDIUM)

- **How it is wired:** No importer: it is the nx generator CLI mandated by AGENTS.md section 1 (`nx g @adhd/workspace-codegen-nx:<tier>`); nx.json:142 builds it.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** no publishConfig v0.1.5; npm last-month downloads 623/mo (see downloads caveat)
- **Last substantive commit:** 2026-09-24 ce53687b fix(nx-build): run-scoped release manifest token + apigen-cli readiness flake + codegen test output (#15); 39 commits total; 18 source files
- **Adversarial attack:** Zero static importers; backlog 24ab2ff3 says its verify is broken (needs TTY).
- **Self-refutation:** Refuted: it is the sole sanctioned package-scaffolding path and was exercised repo-wide (every package carries its tags). It is a tool, not a library.
- **Evidence:** AGENTS.md section 1; nx.json:142; backlog 24ab2ff3-a584-46b0-b350-6e69eb39c58f

### @adhd/agent-mcp (entrypoint/agent-mcp) - KEEP (HIGH)

- **How it is wired:** No importer. Reachable from entrypoint/root via agent-mcp.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v2.3.13; npm last-month downloads 2215/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-13 ac43c6b0 fix(agent-mcp): reap the parity sweep fixture through the guarded sweepPids so the kill-safety audit stays process.kill-free outside lib.mjs (dcf8b7da AC3); 398 commits total; 277 source files
- **Adversarial attack:** Entrypoint: judged by whether it ships a bin/server that is built, smoke-tested and documented.
- **Self-refutation:** Refuted: it is an entrypoint with a bin/server consumed directly by users or by sibling packages.
- **Evidence:** importers listed below

### @adhd/apigen-cli (entrypoint/apigen-cli) - KEEP (HIGH)

- **How it is wired:** No importer. Reachable from entrypoint/root via apigen-cli.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.2.11; npm last-month downloads 1359/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-09 0fbf9a66 chore(deps): dedupe @adhd/sox-telemetry to ^0.4.3 across consumers and regenerate lockfile (c536ce29); 131 commits total; 93 source files
- **Adversarial attack:** Entrypoint: judged by whether it ships a bin/server that is built, smoke-tested and documented.
- **Self-refutation:** Refuted: it is an entrypoint with a bin/server consumed directly by users or by sibling packages.
- **Evidence:** importers listed below

### @adhd/backlog (entrypoint/backlog) - KEEP (HIGH)

- **How it is wired:** Declared dependency of: dispatch-cli (no import statement found). Reachable from entrypoint/root via backlog.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** dispatch-cli
- **Published:** public v1.0.16; npm last-month downloads 2951/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-14 6979a77a test(backlog): disable edge-batch.spec.ts, tracked by backlog 8752d7d5; 290 commits total; 365 source files
- **Adversarial attack:** Entrypoint: judged by whether it ships a bin/server that is built, smoke-tested and documented.
- **Self-refutation:** Refuted: it is an entrypoint with a bin/server consumed directly by users or by sibling packages.
- **Evidence:** importers listed below

### @adhd/decompile-cli (entrypoint/decompile-cli) - KEEP (LOW)

- **How it is wired:** Standalone published CLI (`decompile`); README.md:31 advertises it; depends on data-base-transforms; built in clean-room-smoke.spec.mjs:86.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.2.4; npm last-month downloads 758/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-14 4f88f6c9 test(data-base-transforms): drop dead commented-out legacy blocks from specs; record qa legacy-test audit; 37 commits total; 36 source files
- **Adversarial attack:** Off-mission for an agent/apigen/dispatch monorepo; zero in-repo consumers; the only in-repo link is data-base-transforms (its sole non-data consumer).
- **Self-refutation:** Self-refutation: an entrypoint is allowed to have no importers, and README lists it as a product. Real-world use UNKNOWN (758/mo = floor). If the owner wants a smaller portfolio this is the first non-core cut, but the evidence does not meet the WASTE bar.
- **Evidence:** README.md:23-31; tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.spec.mjs:86; entrypoint/decompile-cli/src/lib/store/index.ts:1

### @adhd/dispatch-cli (entrypoint/dispatch-cli) - KEEP (HIGH)

- **How it is wired:** No importer. Reachable from entrypoint/root via dispatch-cli.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.1.8; npm last-month downloads 941/mo (see downloads caveat)
- **Last substantive commit:** 2026-10-07 4b836e8c build(nx-build): make build/test graphs fully cacheable; cache dist-manifest, verify-dist-load, publish-hygiene, generate-cli, backlog build; 101 commits total; 35 source files
- **Adversarial attack:** Entrypoint: judged by whether it ships a bin/server that is built, smoke-tested and documented.
- **Self-refutation:** Refuted: it is an entrypoint with a bin/server consumed directly by users or by sibling packages.
- **Evidence:** importers listed below

### @adhd/environment-cli (entrypoint/environment-cli) - WASTE (MEDIUM)

- **How it is wired:** Private package, no `bin`, no importer; consumed by nothing.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.1; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-09-25 796a3cc4 fix(environment-cli): default-import yaml so emitted ESM loads, and gate it; 18 commits total; 6 source files
- **Adversarial attack:** `package.json` is `private: true` with no bin; the library surface (`api.ts`/`core.ts`) is imported by nobody (0 prod importers). Its own backlog DEBT-ENV-CLI-002 (open, 7ef20999) states it "has no runnable CLI executable" and packages/environment/BACKLOG.md:6-8 concedes "nothing depends on a terminal entrypoint existing". The real API is the `@adhd/environment` class.
- **Self-refutation:** Self-refutation: DEBT-ENV-CLI-002 is open, is that roadmap? DECISION: no. A roadmap dependency means another planned deliverable needs the package; this item only asks the package to become what its name claims. MEDIUM because the two fix options in that item (generate-cli or commander wrapper) show intent to finish it.
- **Evidence:** entrypoint/environment-cli/package.json:1-12; packages/environment/BACKLOG.md:6-8; backlog 7ef20999-7700-4384-8816-02d0cd071096; nx.json "include" for tsc build lists it

### @adhd/policy (entrypoint/policy) - KEEP (HIGH)

- **How it is wired:** No importer. Reachable from entrypoint/root via policy.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** public v0.0.1; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-10-14 f65fa1b2 fix(policy): policy:test builds its own dist before running (4041424f); 13 commits total; 50 source files
- **Adversarial attack:** Entrypoint: judged by whether it ships a bin/server that is built, smoke-tested and documented.
- **Self-refutation:** Refuted: it is an entrypoint with a bin/server consumed directly by users or by sibling packages.
- **Evidence:** importers listed below

### @adhd/nx-assets (tools/nx-plugins/assets) - KEEP (MEDIUM)

- **How it is wired:** No importer. Reachable from entrypoint/root via nx-assets.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.0; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-10-07 77b432f6 build(nx-build): cache nx-plugins:test with audited inputs; ignore release-written manifest fields; release-reset-check publish-only with HEAD-aware semantics; 16 commits total; 6 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 0 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/nx-build (tools/nx-plugins/build) - KEEP (MEDIUM)

- **How it is wired:** No importer. Reachable from entrypoint/root via nx-build.
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.0; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-10-14 9d681724 fix(test): gate scripts run when the checkout path crosses a symlink; G4 scan 10.9s to 0.6s (c40c33e1); 93 commits total; 73 source files
- **Adversarial attack:** Attack: look for zero/self-only importers; found 0 real importer(s).
- **Self-refutation:** Refuted: has production importers on a path reachable from an entrypoint.
- **Evidence:** importers listed below

### @adhd/nx-deps (tools/nx-plugins/deps) - KEEP (HIGH)

- **How it is wired:** nx.json plugin ./tools/nx-plugins/deps/plugin.js
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.0; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-10-14 9d681724 fix(test): gate scripts run when the checkout path crosses a symlink; G4 scan 10.9s to 0.6s (c40c33e1); 13 commits total; 8 source files
- **Adversarial attack:** Zero importers.
- **Self-refutation:** Refuted: nx.json plugin.
- **Evidence:** nx.json plugins

### @adhd/nx-mass-delete-guard (tools/nx-plugins/mass-delete-guard) - KEEP (HIGH)

- **How it is wired:** root project.json:121 executor + .githooks/pre-commit
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.0; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-08-07 7a5fcc4f fix(githooks): pre-commit gates were fully skippable by a pure-deletion commit; 1 commits total; 1 source files
- **Adversarial attack:** 1-file private executor wrapper.
- **Self-refutation:** Refuted: a real pre-commit and CI gate.
- **Evidence:** project.json (root); .githooks/pre-commit

### @adhd/nx-secret-scan (tools/nx-plugins/secret-scan) - KEEP (HIGH)

- **How it is wired:** root project.json:48 executor + .githooks/pre-commit:113 + CI pull-request.yml:66
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.0; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-07-24 7074b809 chore(tooling): build/deps/lint plugin + pre-commit hook fixes; 2 commits total; 1 source files
- **Adversarial attack:** 1-file private executor wrapper.
- **Self-refutation:** Refuted: a real pre-commit and CI gate.
- **Evidence:** project.json (root); .githooks/pre-commit

### @adhd/nx-test (tools/nx-plugins/test) - KEEP (HIGH)

- **How it is wired:** nx.json plugin ./tools/nx-plugins/test/plugin.js
- **Importers (real import statements, non-test):** 0
  - (none)
- **Test-only importers:** (none)
- **package.json dependents:** (none)
- **Published:** private v0.1.0; npm last-month downloads not on npm (404)/unknown (see downloads caveat)
- **Last substantive commit:** 2026-10-14 65dc1b8c fix(nx-test): the tier S timeout cap is the 30 s project default, not 10 s; 33 commits total; 38 source files
- **Adversarial attack:** Zero importers.
- **Self-refutation:** Refuted: nx.json plugin + gates engine.
- **Evidence:** nx.json plugins

