# graph-js-tsc-inferred — tsc-built projects inferred (phase 2b)

**Phase:** graph · **Kind:** work · **Depends on:** graph-test-build-inferred · **Guard:** `./node_modules/.bin/nx show projects | rg -q "agent-core-policy" && node -e "
const fs=require(\"fs\"),path=require(\"path\");
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){if([\"node_modules\",\".git\",\"dist\",\".nx\"].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p,o);else if(e.name===\"project.json\")o.push(p);}return o;}
let bad=0;for(const f of walk(\".\")){if(fs.readFileSync(f,\"utf8\").includes(\"@nx/js:tsc\")){bad++;console.error(f);}}
process.exit(bad?1:0)"`

---

## Goal

The fourteen tsc-built projects and the bespoke second-pass compile still build, with their targets inferred rather than declared.

---

## Semantic distillation

- CRITICAL: the js plugin is NOT registered. Delete these targets first and the build target vanishes — nothing infers it. Register the plugin as part of this state, not after.
- These targets carry genuinely non-inferable options (assets globs, explicit output paths, clean semantics). The inferred equivalent must reproduce them or the published artifact changes.
- One of the fifteen is a bespoke second-pass compile with an additive-only output setting; it is not a shadow of anything. Treat it as a migration, not a deletion.

---

## Contract promise

```text
added:    ["the js plugin registration"]
modified: ["15 project manifests","nx.json"]
deleted:  ["15 explicit tsc executor targets"]
```

---

## Commit points

- Commit plugin registration and the conversions post-guard.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [graph-js-tsc-inferred.1] No explicit tsc executor target remains

- [graph-js-tsc-inferred.2] The js plugin is registered so the tsc-built projects still infer a build
- [graph-js-tsc-inferred.3] A sample tsc-built project still exposes a build target
- [graph-js-tsc-inferred.4] A sample tsc-built project still produces its build artifact
- [graph-js-tsc-inferred.5] The bespoke second-pass compile still produces its artifact
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "tsconfig.base.json", "package.json"]
mutates:    ["nx.json", "entrypoint/agent-mcp/project.json", "entrypoint/decompile-cli/project.json", "entrypoint/dispatch-cli/project.json", "entrypoint/environment-cli/project.json", "packages/agent/agent-core-policy/project.json", "packages/agent/agent-core-provider/project.json", "packages/agent/agent-engine-compiler/project.json", "packages/agent/agent-engine-orchestrator/project.json", "packages/agent/agent-generator-plugin/project.json", "packages/agent/agent-store-prompts/project.json", "packages/agent/agent-store-runtime/project.json", "packages/agent/agent-store-tools/project.json", "packages/apigen/apigen-generator-nx/project.json", "packages/workspace/workspace-base-tools/project.json", "packages/workspace/workspace-codegen-nx/project.json"]
```

---

## Notes for executor

Phase 2b: the js plugin is NOT registered, so deleting these targets would delete the build target outright. Register it, then convert the 14 tsc builds plus the bespoke build-bin.
