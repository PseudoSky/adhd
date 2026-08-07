// Audit checks for adhd-environment plan
// Format: check("slug.N", "description", "command")
// Used by compile-task.js to populate acceptance_criteria[].check fields

// ── scaffold-workspace ──
check("scaffold-workspace.1", "All 5 library directories exist", "test -d packages/environment/environment-base-spec && test -d packages/environment/environment-builder && test -d packages/environment/environment-core-node && test -d packages/environment/environment-core-py && test -d packages/environment/environment-core-rs")
check("scaffold-workspace.2", "CLI entrypoint exists", "test -d entrypoint/environment-cli")
check("scaffold-workspace.3", "nx.json has plugins", "grep -q '@monodon/rust' nx.json && grep -q '@nxlv/python' nx.json")
check("scaffold-workspace.4", "environment-core-node published as @adhd/environment + tsconfig alias", "node -e 'process.exit(require(\"./packages/environment/environment-core-node/package.json\").name===\"@adhd/environment\"?0:1)' && grep -q '\"@adhd/environment\":' tsconfig.base.json")

// ── contract-base-spec ──
check("contract-base-spec.1", "Schema file exists", "test -f packages/environment/environment-base-spec/spec/adhd-environment.schema.json")
check("contract-base-spec.2", "Test vectors exist", "test -f packages/environment/environment-base-spec/spec/cross-language-test-vectors.json")
check("contract-base-spec.3", "index.ts exports types", "grep -q 'export.*EnvironmentSnapshot' packages/environment/environment-base-spec/src/index.ts")
check("contract-base-spec.5", "Package builds", "npx nx build environment-base-spec")

// ── builder-engine ──
check("builder-engine.1", "Pipeline modules exist", "test -f packages/environment/environment-builder/src/yaml-parser.ts && test -f packages/environment/environment-builder/src/field-merge.ts && test -f packages/environment/environment-builder/src/config-resolver.ts && test -f packages/environment/environment-builder/src/json-schema-gen.ts && test -f packages/environment/environment-builder/src/provenance.ts && test -f packages/environment/environment-builder/src/validation.ts && test -f packages/environment/environment-builder/src/snapshot-writer.ts")
check("builder-engine.7", "inferEnvVar works", "node -e 'const m=require(\"./packages/environment/environment-builder/src/config-resolver\"); console.log(m.inferEnvVar(\"ADHD_AGENT_MCP\",\"db.path\"))' | grep -q ADHD_AGENT_MCP_DB_PATH")
check("builder-engine.9", "Package builds", "npx nx build environment-builder")

// ── builder-snapshot-api ──
check("builder-snapshot-api.1", "EnvironmentSnapshot class exists", "test -f packages/environment/environment-builder/src/environment-snapshot.ts")
check("builder-snapshot-api.9", "Package builds", "npx nx build environment-builder")

// ── runtime-core-node ──
check("runtime-core-node.1", "Environment class exists", "test -f packages/environment/environment-core-node/src/environment.ts")
check("runtime-core-node.2", "Environment exports correctly", "node -e 'const e=require(\"./packages/environment/environment-core-node/src/environment\"); console.log(typeof e.Environment)' | grep -q 'function'")
check("runtime-core-node.3", "Runtime surface present (hash/version/provenance/bracket/scope)", "F=packages/environment/environment-core-node/src/environment.ts; grep -q provenance $F && grep -q version $F && grep -q hash $F && grep -qi scope $F && grep -q Proxy $F")
check("runtime-core-node.4", "Runtime unit tests pass", "npx nx test environment-core-node")
check("runtime-core-node.5", "Published as @adhd/environment", "node -e 'process.exit(require(\"./packages/environment/environment-core-node/package.json\").name===\"@adhd/environment\"?0:1)')")
check("runtime-core-node.10", "Package builds", "npx nx build environment-core-node")

// ── runtime-cli ──
check("runtime-cli.1", "api.ts exists", "test -f entrypoint/environment-cli/src/api.ts")
check("runtime-cli.2", "set command exists", "test -f entrypoint/environment-cli/src/commands/set.ts")
check("runtime-cli.3", "set command is implemented", "grep -q 'export.*set' entrypoint/environment-cli/src/commands/set.ts")
check("runtime-cli.4", "All 9 apigen command functions exported from api.ts", "F=entrypoint/environment-cli/src/api.ts; grep -q 'function init' $F && grep -q 'function build' $F && grep -q 'function set' $F && grep -q 'function status' $F && grep -q 'function verify' $F && grep -q 'function doctor' $F && grep -q 'function configGet' $F && grep -q 'function exportSnapshot' $F && grep -q 'function diff' $F")
check("runtime-cli.5", "CLI smoke/integration tests pass", "npx nx test environment-cli")
check("runtime-cli.9", "Package builds", "npx nx build environment-cli")

// ── runtime-py ──
check("runtime-py.1", "Python Environment exists", "test -f packages/environment/environment-core-py/src/adhd_environment/environment.py")
check("runtime-py.2", "Python tests pass", "cd packages/environment/environment-core-py && python -m pytest tests/ -v")
check("runtime-py.3", "Python imports without error", "python3 -c 'import sys; sys.path.insert(0,\"packages/environment/environment-core-py/src\"); from adhd_environment.environment import Environment; print(\"OK\")'")
check("runtime-py.8", "Wheel builds", "cd packages/environment/environment-core-py && python -m build")

// ── runtime-rs ──
check("runtime-rs.1", "Rust lib exists", "test -f packages/environment/environment-core-rs/src/lib.rs")
check("runtime-rs.2", "Rust tests pass", "cd packages/environment/environment-core-rs && cargo test")
check("runtime-rs.3", "Rust clippy passes", "cd packages/environment/environment-core-rs && cargo clippy -- -D warnings")
check("runtime-rs.6", "Rust builds", "cd packages/environment/environment-core-rs && cargo build")

// ── refactor-agent-mcp ──
check("refactor-agent-mcp.1", "Old config.ts removed", "test ! -f entrypoint/agent-mcp/src/config.ts")
check("refactor-agent-mcp.2", "adhd.environment.yaml exists with envPrefixOverride ADHD_AGENT", "test -f entrypoint/agent-mcp/adhd.environment.yaml && grep -Eq 'envPrefixOverride:[[:space:]]*ADHD_AGENT' entrypoint/agent-mcp/adhd.environment.yaml")
check("refactor-agent-mcp.3", "load-env.ts removed (real path src/utils/load-env.ts)", "test ! -f entrypoint/agent-mcp/src/utils/load-env.ts")
check("refactor-agent-mcp.4", "agent-mcp test suite passes after refactor", "npx nx test agent-mcp")
check("refactor-agent-mcp.5", "getProviderConfig preserved in new environment.ts module (not tree-wide grep)", "test -f entrypoint/agent-mcp/src/environment.ts && grep -qs getProviderConfig entrypoint/agent-mcp/src/environment.ts")
check("refactor-agent-mcp.6", "26 legacy ADHD_AGENT_* env vars mapped in adhd.environment.yaml (not tree-wide grep)", "test -f entrypoint/agent-mcp/adhd.environment.yaml && grep -qs ADHD_AGENT_DATABASE_PATH entrypoint/agent-mcp/adhd.environment.yaml && grep -qs ADHD_AGENT_OPENAI_SECRET entrypoint/agent-mcp/adhd.environment.yaml && grep -qs ADHD_AGENT_LOG_LEVEL entrypoint/agent-mcp/adhd.environment.yaml")

// ── audit-builder ──
check("audit-builder.1", "Builder packages build", "npx nx build environment-base-spec && npx nx build environment-builder")

// ── audit-runtime ──
check("audit-runtime.1", "TS runtime builds", "npx nx build environment-core-node")
check("audit-runtime.2", "Python builds", "cd packages/environment/environment-core-py && python -m build")
check("audit-runtime.3", "Rust builds", "cd packages/environment/environment-core-rs && cargo build")

// ── audit-final ──
check("audit-final.1", "All packages build", "npx nx run-many -t build --projects=environment-*")
check("audit-final.2", "Init generates YAML", "adhd-env init --generate-config")
check("audit-final.3", "Set+build round-trips", "adhd-env set test.key test-val --namespace default && adhd-env build")
check("audit-final.4", "Build writes snapshot", "adhd-env build --namespace production")
check("audit-final.5", "Typed env constructs", "node -e 'new (require(\"@adhd/environment\").Environment)({project:\"test\",namespace:\"default\"})'")
check("audit-final.6", "contentHash matches vector", "node -e 'const{contentHash}=require(\"@adhd/environment\"); process.exit(contentHash({b:\"2\",a:\"1\"})===\"sha256-66e4efebc74d002dabcf821c0ee1402726e5c9d25a8469e7fc3f7d7691464788\"?0:1)'")
check("audit-final.7", "Old config.ts is gone", "test ! -f entrypoint/agent-mcp/src/config.ts")
check("audit-final.8", "EnvironmentSnapshot API works", "node -e 'const{build}=require(\"@adhd/environment-builder\"); const s=build({project:{name:\"t\",envPrefix:\"T\"}}); [\"get\",\"set\",\"configPath\",\"write\"].every(m=>typeof s[m]===\"function\")'")

// ── docs-steward ──
check("docs-steward.1", "Package READMEs exist", "test -f packages/environment/environment-core-node/README.md && test -f entrypoint/environment-cli/README.md && test -f packages/environment/environment-core-py/README.md && test -f packages/environment/environment-core-rs/README.md")
check("docs-steward.2", "README has usage examples", "grep -q 'new Environment' packages/environment/environment-core-node/README.md")
