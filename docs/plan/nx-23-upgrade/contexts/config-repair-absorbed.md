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

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["nx.json", "CHANGELOG.md", "packages/agent/agent-core-env/package.json", "packages/agent/agent-core-policy/package.json", "packages/agent/agent-core-provider/package.json", "packages/agent/agent-engine-compiler/package.json", "packages/agent/agent-engine-orchestrator/package.json", "packages/agent/agent-store-prompts/package.json", "packages/agent/agent-store-runtime/package.json", "packages/agent/agent-store-tools/package.json", "entrypoint/decompile-cli/package.json"]
```

---

## Notes for executor

Absorb perf/nx-cfgfix into the upgrade branch. CRITICAL: the branch drops lint from the test target, which main reverted for BUG-060 (publish gate). Resolve the conflict in favour of the restored lint dependency.
