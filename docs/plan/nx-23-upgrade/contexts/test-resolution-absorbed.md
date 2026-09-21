# test-resolution-absorbed — STATE_NAME

**Phase:** reconcile · **Kind:** work · **Depends on:** config-repair-absorbed · **Guard:** `test -f tools/vite-plugins/source-resolution.mjs && node -e "if(!require(\"./nx.json\").namedInputs.sharedGlobals.join(\"|\").includes(\"source-resolution.mjs\"))process.exit(1)" && ./node_modules/.bin/nx show projects | rg -q "workspace-codegen-nx"`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [test-resolution-absorbed.1] The shared test-time source resolution helper exists

- [test-resolution-absorbed.2] The helper exports the pre-ordered plugin used by project configs
- [test-resolution-absorbed.3] The helper is part of the shared cache inputs
- [test-resolution-absorbed.4] The codegen template carries the helper so new projects cannot miss it
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "tools/vite-plugins/vitest-pool-defaults.mjs", "vitest.config.ts", "package.json"]
mutates:    ["tools/vite-plugins/source-resolution.mjs", "tools/vite-plugins/README.md", "tools/vite-plugins/externalize.mjs", "nx.json", "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts", "packages/workspace/workspace-codegen-nx/src/generators/shared/source-resolution-optout.spec.ts", "entrypoint/agent-mcp/vite.config.ts", "entrypoint/apigen-cli/vite.config.ts", "entrypoint/backlog/vite.config.ts", "entrypoint/decompile-cli/vite.config.ts", "entrypoint/dispatch-cli/vite.config.ts", "entrypoint/environment-cli/vite.config.ts", "packages/agent/agent-engine-compiler/vite.config.ts", "packages/apigen/apigen-engine-conformance/vite.config.ts"]
```

---

## Notes for executor

Absorb perf/test-resolve-fix. It makes the test module graph continuous across package boundaries, which is the precondition for cross-package file-level selection. Keep the 4 child-process opt-outs.
