# config-repair-absorbed — Config-repair branch absorbed, publish gate intact

**Phase:** reconcile · **Kind:** work · **Depends on:** gate-triage-absorbed · **Guard:** `./node_modules/.bin/nx show projects | rg -q "data-query-engine" && node -e "const d=require(\"./nx.json\").targetDefaults.test.dependsOn;if(!d.includes(\"lint\")||!d.includes(\"^build\"))process.exit(1)" && node -e "const s=require(\"./packages/agent/agent-core-env/package.json\").scripts;if(s&&s.build)process.exit(1)"`

---

## Goal

The four unpushed config-repair commits live on the upgrade branch, and the publish gate they would have removed is still in place.

---

## Semantic distillation

- TRAP: the absorbed branch drops `lint` from the default test target. main reverted exactly that for BUG-060 — `publish`/`nx-release-publish` reach lint only via `test`, so dropping it silently disables dependency checks on every release.
- Resolve that conflict in favour of `["lint", "^build"]`. This is the single most important decision in the state.
- Deleting the nine self-referential build scripts is safe and orthogonal — they are redundant wrappers, not the real build target.

---

## Contract promise

```text
added:    []
modified: ["nx.json","CHANGELOG.md"]
deleted:  ["scripts.build from nine package manifests"]
```

---

## Commit points

- Absorb the commits, resolve the nx.json conflict, then commit the resolution separately so the decision is diffable.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [config-repair-absorbed.1] The default test target still depends on lint, preserving the publish gate

- [config-repair-absorbed.2] No self-referential build script remains in the nine recovered manifests
- [config-repair-absorbed.3] A sample recovered project still exposes an inferred build target
- [config-repair-absorbed.4] A sample recovered project builds successfully
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "tools/nx-plugins/build/plugin.js", "tools/nx-plugins/lint/plugin.js", "package.json"]
mutates:    ["nx.json", "CHANGELOG.md", "packages/agent/agent-core-env/package.json", "packages/agent/agent-core-policy/package.json", "packages/agent/agent-core-provider/package.json", "packages/agent/agent-engine-compiler/package.json", "packages/agent/agent-engine-orchestrator/package.json", "packages/agent/agent-store-prompts/package.json", "packages/agent/agent-store-runtime/package.json", "packages/agent/agent-store-tools/package.json", "entrypoint/decompile-cli/package.json"]
```

---

## Notes for executor

Absorb perf/nx-cfgfix into the upgrade branch. CRITICAL: the branch drops lint from the test target, which main reverted for BUG-060 (publish gate). Resolve the conflict in favour of the restored lint dependency.
