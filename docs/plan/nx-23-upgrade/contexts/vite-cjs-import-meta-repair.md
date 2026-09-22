# vite-cjs-import-meta-repair — STATE_NAME

**Phase:** intake · **Kind:** work · **Depends on:** upgrade-baseline · **Guard:** `test -f tools/vite-plugins/import-meta-url-cjs.mjs && test "$(git log -1 --format=%H -- tools/vite-plugins/import-meta-url-cjs.mjs)" = "$(git log -1 --format=%H -- package.json)" && ./node_modules/.bin/nx build apigen-cli && ./node_modules/.bin/nx build backlog && node entrypoint/apigen-cli/dist/index.js --help | grep -q "Usage: apigen" && node entrypoint/backlog/dist/index.js --help | grep -q "install-skill" && node -e "const fs=require('fs');for(const f of ['entrypoint/apigen-cli/dist/index.js','entrypoint/backlog/dist/index.js']){const t=fs.readFileSync(f,'utf8');if(t.includes('{}.url')){console.error('EMPTY_IMPORT_META_URL in '+f);process.exit(1)}}console.log('CJS_ARTIFACTS_LOAD')"`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [vite-cjs-import-meta-repair.1] The built CommonJS entrypoints load and run as real processes, not merely declare the bumped version

- [vite-cjs-import-meta-repair.2] The default-running acceptance spec drives the BUILT CJS artifact and passes
- [vite-cjs-import-meta-repair.3] Every CJS-emitting vite config in the workspace is wired to the shared shim
- [vite-cjs-import-meta-repair.4] The shared format-gated shim plugin exists
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "tsconfig.base.json", "entrypoint/apigen-cli/project.json", "entrypoint/backlog/project.json"]
mutates:    ["tools/vite-plugins/import-meta-url-cjs.mjs", "tools/vite-plugins/README.md", "entrypoint/apigen-cli/src/test/e2e/cjs-import-meta-url.spec.ts", "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts", "packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts", "docs/plan/nx-23-upgrade/scripts/neg-control-cjs-shim.mjs", "docs/plan/nx-23-upgrade/VITE-CJS-REPAIR.md", "package.json", "pnpm-lock.yaml", "entrypoint/agent-mcp/vite.config.ts", "entrypoint/apigen-cli/vite.config.ts", "entrypoint/backlog/vite.config.ts", "entrypoint/dispatch-cli/vite.config.ts", "packages/agent/agent-base-types/vite.config.ts", "packages/agent/agent-core-env/vite.config.ts", "packages/agent/agent-core-policy/vite.config.ts", "packages/agent/agent-core-provider/vite.config.ts", "packages/agent/agent-engine-orchestrator/vite.config.ts", "packages/agent/agent-generator-plugin/vite.config.ts", "packages/agent/agent-plugin-budget/vite.config.ts", "packages/agent/agent-plugin-sanitize/vite.config.ts", "packages/agent/agent-store-runtime/vite.config.ts", "packages/apigen/apigen-base-errors/vite.config.ts", "packages/apigen/apigen-base-logical/vite.config.ts", "packages/apigen/apigen-base-schema/vite.config.ts", "packages/apigen/apigen-base-types/vite.config.ts", "packages/apigen/apigen-core-client/vite.config.ts", "packages/apigen/apigen-engine-conformance/vite.config.ts", "packages/apigen/apigen-engine-gateway/vite.config.ts", "packages/apigen/apigen-engine-naming/vite.config.ts", "packages/apigen/apigen-engine-runtime/vite.config.ts", "packages/apigen/apigen-generator-nx/vite.config.ts", "packages/apigen/apigen-plugin-api-express/vite.config.ts", "packages/apigen/apigen-plugin-api-fastify/vite.config.ts", "packages/apigen/apigen-plugin-batch/vite.config.ts", "packages/apigen/apigen-plugin-cli-output/vite.config.ts", "packages/apigen/apigen-plugin-health/vite.config.ts", "packages/apigen/apigen-plugin-ir-cache/vite.config.ts", "packages/apigen/apigen-plugin-java-javalin/vite.config.ts", "packages/apigen/apigen-plugin-jsonschema/vite.config.ts", "packages/apigen/apigen-plugin-logger/vite.config.ts", "packages/apigen/apigen-plugin-mcp/vite.config.ts", "packages/apigen/apigen-plugin-openapi/vite.config.ts", "packages/apigen/apigen-plugin-py-flask/vite.config.ts", "packages/apigen/apigen-plugin-py-grpc/vite.config.ts", "packages/apigen/apigen-plugin-ts-types/vite.config.ts", "packages/apigen/codegen/openapi/vite.config.ts", "packages/apigen/python-env/vite.config.ts", "packages/data/data-base-transforms/vite.config.ts", "packages/data/data-core-structures/vite.config.ts", "packages/data/data-query-engine/vite.config.ts", "packages/dispatch/dispatch-base-spec/vite.config.ts", "packages/dispatch/dispatch-base-types/vite.config.ts", "packages/dispatch/dispatch-core-client/vite.config.ts", "packages/dispatch/dispatch-core-optimizer/vite.config.ts", "packages/dispatch/dispatch-orchestrator/vite.config.ts", "packages/dispatch/dispatch-serializer-json/vite.config.ts", "packages/environment/environment-base-spec/vite.config.ts", "packages/environment/environment-builder/vite.config.ts", "packages/environment/environment-core-node/vite.config.ts", "packages/workspace/workspace-base-standard/vite.config.ts", "packages/workspace/workspace-base-vite-paths/vite.config.ts", "packages/workspace/workspace-codegen-nx/vite.config.ts"]
```

---

## Notes for executor

Land the in-flight vite 8 CJS import.meta.url fix and the vite bump in ONE commit. The guard proves atomicity (the plugin file and package.json were last touched by the same commit) AND that the built CJS artifacts actually load. A version-pin guard is what let BUG-BUILD-002 hide.
