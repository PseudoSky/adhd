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
mutates:    ["nx.json", "entrypoint/agent-mcp/project.json", "entrypoint/decompile-cli/project.json", "entrypoint/dispatch-cli/project.json", "entrypoint/environment-cli/project.json", "packages/agent/agent-core-policy/project.json", "packages/agent/agent-core-provider/project.json", "packages/agent/agent-engine-compiler/project.json", "packages/agent/agent-engine-orchestrator/project.json", "packages/agent/agent-generator-plugin/project.json", "packages/agent/agent-store-prompts/project.json", "packages/agent/agent-store-runtime/project.json", "packages/agent/agent-store-tools/project.json", "packages/apigen/apigen-generator-nx/project.json", "packages/workspace/workspace-base-tools/project.json", "packages/workspace/workspace-codegen-nx/project.json", "project.json"]
```

---

## Notes for executor

Phase 2b: the js plugin is NOT registered, so deleting these targets would delete the build target outright. Register it, then convert the 14 tsc builds plus the bespoke build-bin.

---

## Measured outcome / deviations (recorded post-completion)

Recorded after the state completed — work commit `5b038916`, complete commit `97edb13b`, guard re-verified green. The authoring-time premise above ("Register it, then convert the 14 tsc builds plus the bespoke build-bin") proved **false in its implied mechanism**: the plugin's inferred target cannot simply replace the retired executor here. This block is the plan's record of what actually landed.

### The inferred `tsc --build tsconfig.lib.json` cannot run in this workspace

Three independent reasons, all outside this state's file reservations:

1. The inferred target carries `syncGenerators: ["@nx/js:typescript-sync"]`, and that generator hard-fails with `Missing root "tsconfig.json"` — this repo has `tsconfig.base.json`, not `tsconfig.json`.
2. `tsconfig.lib.json` declares no project references, so `--build` cannot redirect the `tsconfig.base.json` source path aliases to declaration outputs and dies with `TS6059`/`TS6307` (reproduced: 30+ errors).
3. The inferred target's `outDir` is the workspace-root `dist/<pkg>`, not `{projectRoot}/dist`, where every consumer (`assets`, `dist-manifest`, `verify-dist-load`, `npm-release-publish`) looks.

### What was actually done

- Plugin-inferred `build` targets with **override-only** `project.json` entries: each override supplies a `command` that reproduces the retired executor using the **workspace** TypeScript (`node_modules/typescript/bin/tsc` — the plugin's bare `tsc` resolves the package-local `typescript@5.9.3` first and dies with `TS5103` on the repo-wide `ignoreDeprecations: "6.0"`), with `--rootDir {projectRoot} --outDir {projectRoot}/dist --baseUrl {projectRoot} --composite false --noEmitOnError`, plus a trailing `cp` for the non-inferable asset globs.
- `sync.disabledTaskSyncGenerators: ["@nx/js:typescript-sync"]` in `nx.json` (disables the hard-failing sync generator).
- The dead `targetDefaults["@nx/js:tsc"]` key removed from `nx.json`.
- Artifact parity proven for `agent-core-policy`: 40 files, `.js`/`.d.ts` byte-identical to the retired executor's output (source maps identical once `outDir` matches).

### Open deviations — surfaced to the human for decision (NOT blessed)

1. **`clean` semantics are not reproduced.** The retired executor's `clean` (pre-build removal of stale outputs) is gone: the tsc build is additive (overwrites), so stale files can accumulate in `dist/` and be published over time. Reproducing it means an fs removal inside a build command, which the repo rules require human approval for. **Decision pending.**
2. **`dist/package.json` is now materialized by `dist-manifest`, not at build time.** For publishable projects the rebased `dist/package.json` is produced by the `dist-manifest` target rather than during the build. The publish pipeline was verified green (`verify-dist-load` + `publish-hygiene`), so the consumer-visible outcome is intact; recorded because it is a timing/shape change from the retired executor. **Decision pending.**
