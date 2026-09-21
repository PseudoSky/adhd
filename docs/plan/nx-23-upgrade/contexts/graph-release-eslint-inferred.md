# graph-release-eslint-inferred — STATE_NAME

**Phase:** graph · **Kind:** work · **Depends on:** graph-js-tsc-inferred · **Guard:** `./node_modules/.bin/nx show projects | rg -q "apigen-plugin-jsonschema" && node -e "
const fs=require(\"fs\"),path=require(\"path\");
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){if([\"node_modules\",\".git\",\"dist\",\".nx\"].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p,o);else if(e.name===\"project.json\")o.push(p);}return o;}
let bad=0;for(const f of walk(\".\")){const t=fs.readFileSync(f,\"utf8\");if(t.includes(\"@nx/js:release-publish\")||t.includes(\"@nx/eslint:lint\")){bad++;console.error(f);}}
process.exit(bad?1:0)"`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "tsconfig.base.json", "package.json", "tools/nx-plugins/build/plugin.js"]
mutates:    ["nx.json", "packages/apigen/apigen-plugin-api-express/project.json", "packages/apigen/apigen-plugin-api-fastify/project.json", "packages/apigen/apigen-plugin-batch/project.json", "packages/apigen/apigen-plugin-cli-output/project.json", "packages/apigen/apigen-plugin-health/project.json", "packages/apigen/apigen-plugin-java-javalin/project.json", "packages/apigen/apigen-plugin-jsonschema/project.json", "packages/apigen/apigen-plugin-logger/project.json", "packages/apigen/apigen-plugin-mcp/project.json", "packages/apigen/apigen-plugin-openapi/project.json", "packages/apigen/apigen-plugin-py-flask/project.json", "packages/apigen/apigen-plugin-py-grpc/project.json", "packages/apigen/apigen-plugin-batch/project.json", "packages/apigen/apigen-plugin-ir-cache/project.json", "packages/apigen/apigen-plugin-ts-types/project.json", "packages/workspace/workspace-base-standard/project.json", "packages/workspace/workspace-base-vite-paths/project.json"]
```

---

## Notes for executor

Phase 2c: the deprecated eslint lint targets go through the sanctioned convert-to-inferred codemod; the twelve release targets have bespoke dependency chains that must survive the move to inference.
