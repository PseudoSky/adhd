# graph-release-eslint-inferred — Release and lint targets inferred (phase 2c)

**Phase:** graph · **Kind:** work · **Depends on:** graph-js-tsc-inferred · **Guard:** `./node_modules/.bin/nx show projects | rg -q "apigen-plugin-jsonschema" && node -e "
const fs=require(\"fs\"),path=require(\"path\");
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){if([\"node_modules\",\".git\",\"dist\",\".nx\"].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p,o);else if(e.name===\"project.json\")o.push(p);}return o;}
let bad=0;for(const f of walk(\".\")){const t=fs.readFileSync(f,\"utf8\");if(t.includes(\"@nx/js:release-publish\")||t.includes(\"@nx/eslint:lint\")){bad++;console.error(f);}}
process.exit(bad?1:0)"`

---

## Goal

The twelve release targets and five deprecated lint targets are inferred, with their dependency chains and the publish gate preserved.

---

## Semantic distillation

- The release targets each carry a bespoke dependency chain. Inference supplies the target; the chain must still be declared, or releases stop gating on tests and artifact verification.
- The lint targets go through Nx's sanctioned convert-to-inferred codemod — use it rather than hand-deleting.
- A lint path that REWRITES tracked manifests is not a correct check path. The criterion asserting the check-only sibling is a direct consequence of remodelling this target, not a separate goal.

---

## Contract promise

```text
added:    []
modified: ["17 project manifests","nx.json"]
deleted:  ["12 release + 5 lint explicit executor targets"]
```

---

## Commit points

- Commit the codemod output and the release-chain carry-over post-guard.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [graph-release-eslint-inferred.1] No explicit release-publish executor target remains

- [graph-release-eslint-inferred.2] No deprecated eslint executor target remains
- [graph-release-eslint-inferred.3] A sample publishable project still exposes a release target
- [graph-release-eslint-inferred.4] A sample project still lints clean through the inferred target
- [graph-release-eslint-inferred.5] The lint path no longer rewrites tracked manifests
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "tsconfig.base.json", "package.json", "tools/nx-plugins/build/plugin.js"]
mutates:    ["nx.json", "packages/apigen/apigen-plugin-api-express/project.json", "packages/apigen/apigen-plugin-api-fastify/project.json", "packages/apigen/apigen-plugin-batch/project.json", "packages/apigen/apigen-plugin-cli-output/project.json", "packages/apigen/apigen-plugin-health/project.json", "packages/apigen/apigen-plugin-java-javalin/project.json", "packages/apigen/apigen-plugin-jsonschema/project.json", "packages/apigen/apigen-plugin-logger/project.json", "packages/apigen/apigen-plugin-mcp/project.json", "packages/apigen/apigen-plugin-openapi/project.json", "packages/apigen/apigen-plugin-py-flask/project.json", "packages/apigen/apigen-plugin-py-grpc/project.json", "packages/apigen/apigen-plugin-batch/project.json", "packages/apigen/apigen-plugin-ir-cache/project.json", "packages/apigen/apigen-plugin-ts-types/project.json", "packages/workspace/workspace-base-standard/project.json", "packages/workspace/workspace-base-vite-paths/project.json"]
```

---

## Notes for executor

Phase 2c: the deprecated eslint lint targets go through the sanctioned convert-to-inferred codemod; the twelve release targets have bespoke dependency chains that must survive the move to inference.
