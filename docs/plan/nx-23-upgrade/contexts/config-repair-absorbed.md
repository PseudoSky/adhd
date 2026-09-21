# config-repair-absorbed — STATE_NAME

**Phase:** reconcile · **Kind:** work · **Depends on:** gate-triage-absorbed · **Guard:** `./node_modules/.bin/nx show projects | rg -q "data-query-engine" && node -e "const d=require(\"./nx.json\").targetDefaults.test.dependsOn;if(!d.includes(\"lint\")||!d.includes(\"^build\"))process.exit(1)" && node -e "const s=require(\"./packages/agent/agent-core-env/package.json\").scripts;if(s&&s.build)process.exit(1)"`

---

## Goal

<What is true after this state that was not true before?>

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
