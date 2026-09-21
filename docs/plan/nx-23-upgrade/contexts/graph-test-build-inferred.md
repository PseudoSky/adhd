# graph-test-build-inferred — STATE_NAME

**Phase:** graph · **Kind:** work · **Depends on:** audit-config · **Guard:** `./node_modules/.bin/nx show project data-query-engine --json | rg -q "\"test\"" && ./node_modules/.bin/nx show project data-base-transforms --json | rg -q "\"build\"" && node -e "
const fs=require(\"fs\"),path=require(\"path\");
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){if([\"node_modules\",\".git\",\"dist\",\".nx\"].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p,o);else if(e.name===\"project.json\")o.push(p);}return o;}
let bad=0;for(const f of walk(\".\")){const t=fs.readFileSync(f,\"utf8\");if(t.includes(\"@nx/vitest:test\")||t.includes(\"@nx/vite:build\")){bad++;console.error(f);}}
process.exit(bad?1:0)"`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [graph-test-build-inferred.1] No explicit test executor target remains to shadow inference

- [graph-test-build-inferred.2] No explicit build executor target remains to shadow inference
- [graph-test-build-inferred.3] A sample project still exposes an inferred test target
- [graph-test-build-inferred.4] A sample project still exposes an inferred build target
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "tsconfig.base.json"]
mutates:    ["entrypoint/agent-mcp/project.json", "entrypoint/apigen-cli/project.json", "entrypoint/backlog/project.json", "entrypoint/decompile-cli/project.json", "entrypoint/dispatch-cli/project.json", "entrypoint/environment-cli/project.json", "packages/agent/agent-base-types/project.json", "packages/agent/agent-core-env/project.json", "packages/agent/agent-core-policy/project.json", "packages/agent/agent-core-provider/project.json", "packages/agent/agent-engine-compiler/project.json", "packages/agent/agent-engine-orchestrator/project.json", "packages/agent/agent-generator-plugin/project.json", "packages/agent/agent-plugin-budget/project.json", "packages/agent/agent-plugin-sanitize/project.json", "packages/agent/agent-store-prompts/project.json", "packages/agent/agent-store-runtime/project.json", "packages/agent/agent-store-tools/project.json", "packages/apigen/apigen-base-errors/project.json", "packages/apigen/apigen-base-logical/project.json", "packages/apigen/apigen-base-schema/project.json", "packages/apigen/apigen-base-types/project.json", "packages/apigen/apigen-core-client/project.json", "packages/apigen/apigen-engine-conformance/project.json", "packages/apigen/apigen-engine-gateway/project.json", "packages/apigen/apigen-engine-naming/project.json", "packages/apigen/apigen-engine-runtime/project.json", "packages/apigen/apigen-generator-nx/project.json", "packages/apigen/apigen-plugin-api-express/project.json", "packages/apigen/apigen-plugin-api-fastify/project.json", "packages/apigen/apigen-plugin-batch/project.json", "packages/apigen/apigen-plugin-cli-output/project.json", "packages/apigen/apigen-plugin-health/project.json", "packages/apigen/apigen-plugin-ir-cache/project.json", "packages/apigen/apigen-plugin-java-javalin/project.json", "packages/apigen/apigen-plugin-jsonschema/project.json", "packages/apigen/apigen-plugin-logger/project.json", "packages/apigen/apigen-plugin-mcp/project.json", "packages/apigen/apigen-plugin-openapi/project.json", "packages/apigen/apigen-plugin-py-flask/project.json", "packages/apigen/apigen-plugin-py-grpc/project.json", "packages/apigen/apigen-plugin-ts-types/project.json", "packages/apigen/codegen/openapi/project.json", "packages/apigen/python-env/project.json", "packages/data/data-base-transforms/project.json", "packages/data/data-core-structures/project.json", "packages/data/data-query-engine/project.json", "packages/dispatch/dispatch-base-spec/project.json", "packages/dispatch/dispatch-base-types/project.json", "packages/dispatch/dispatch-core-client/project.json", "packages/dispatch/dispatch-core-optimizer/project.json", "packages/dispatch/dispatch-orchestrator/project.json", "packages/dispatch/dispatch-serializer-json/project.json", "packages/environment/environment-base-spec/project.json", "packages/environment/environment-builder/project.json", "packages/environment/environment-core-node/project.json", "packages/ui-react/ui-react-base-hooks/project.json", "packages/ui-react/ui-react-base-storybook/project.json", "packages/workspace/workspace-base-standard/project.json", "packages/workspace/workspace-base-tools/project.json", "packages/workspace/workspace-base-vite-paths/project.json", "packages/workspace/workspace-codegen-nx/project.json", "project.json"]
```

---

## Notes for executor

Phase 2a of the task-graph remodel: delete the 104 explicit executor targets that exactly shadow what the registered vitest and vite plugins already infer, carrying their options into the inferred configuration.
