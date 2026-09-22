# test-resolution-absorbed — Test-time source resolution helper absorbed

**Phase:** reconcile · **Kind:** work · **Depends on:** config-repair-absorbed · **Guard:** `test -f tools/vite-plugins/source-resolution.mjs && node -e "if(!require(\"./nx.json\").namedInputs.sharedGlobals.join(\"|\").includes(\"source-resolution.mjs\"))process.exit(1)" && ./node_modules/.bin/nx show projects | rg -q "workspace-codegen-nx"`

---

## Goal

The vitest module graph is continuous across package boundaries during tests, so a dependent package's specs can see a dependency's source.

---

## Semantic distillation

- Root cause: vite's built-in resolver runs before normal-order plugins, so the tsconfig-paths plugin is only consulted when it returns null — and a symlinked workspace package IS resolvable, so built output wins.
- The fix hoists a copy of that plugin ahead of the built-in resolver and scopes it to serve mode. The serve scoping is LOAD-BEARING: unscoped, it also reorders the production build and shrinks the published artifact.
- Four child-process projects spawn real `node`, which still resolves to built output. They need the opt-out and they need `^build` kept. Do not 'fix' them.

---

## Contract promise

```text
added:    ["tools/vite-plugins/source-resolution.mjs","packages/workspace/workspace-codegen-nx/src/generators/shared/source-resolution-optout.spec.ts"]
modified: ["nx.json",".mcp.json","tools/vite-plugins/README.md","tools/vite-plugins/externalize.mjs","packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts","packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts","packages/apigen/apigen-plugin-api-express/src/index.ts","3 codegen vite.config.ts templates","62 project vite configs"]
deleted:  []
```

---

## Commit points

- Commit the absorption and the conflict resolution post-guard.

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
mutates:    ["tools/vite-plugins/source-resolution.mjs", "tools/vite-plugins/README.md", "tools/vite-plugins/externalize.mjs", "nx.json", ".mcp.json", "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts", "packages/workspace/workspace-codegen-nx/src/generators/shared/source-resolution-optout.spec.ts", "packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts", "packages/agent/agent-generator-plugin/src/generators/registry-package/__files__/vite.config.ts__tmpl__", "packages/apigen/apigen-generator-nx/src/generators/host/__files__/vite.config.ts__tmpl__", "packages/apigen/apigen-generator-nx/src/generators/plugin/__files__/vite.config.ts__tmpl__", "packages/apigen/apigen-plugin-api-express/src/index.ts", "entrypoint/agent-mcp/vite.config.ts", "entrypoint/apigen-cli/vite.config.ts", "entrypoint/backlog/vite.config.ts", "entrypoint/decompile-cli/vite.config.ts", "entrypoint/dispatch-cli/vite.config.ts", "entrypoint/environment-cli/vite.config.ts", "packages/agent/agent-base-types/vite.config.ts", "packages/agent/agent-core-env/vite.config.ts", "packages/agent/agent-core-policy/vite.config.ts", "packages/agent/agent-core-provider/vite.config.ts", "packages/agent/agent-engine-compiler/vite.config.ts", "packages/agent/agent-engine-orchestrator/vite.config.ts", "packages/agent/agent-generator-plugin/vite.config.ts", "packages/agent/agent-plugin-budget/vite.config.ts", "packages/agent/agent-plugin-sanitize/vite.config.ts", "packages/agent/agent-store-prompts/vite.config.ts", "packages/agent/agent-store-runtime/vite.config.ts", "packages/agent/agent-store-tools/vite.config.ts", "packages/apigen/apigen-base-errors/vite.config.ts", "packages/apigen/apigen-base-logical/vite.config.ts", "packages/apigen/apigen-base-schema/vite.config.ts", "packages/apigen/apigen-base-types/vite.config.ts", "packages/apigen/apigen-core-client/vite.config.ts", "packages/apigen/apigen-engine-conformance/vite.config.ts", "packages/apigen/apigen-engine-gateway/vite.config.ts", "packages/apigen/apigen-engine-naming/vite.config.ts", "packages/apigen/apigen-engine-runtime/vite.config.ts", "packages/apigen/apigen-generator-nx/vite.config.ts", "packages/apigen/apigen-plugin-api-express/vite.config.ts", "packages/apigen/apigen-plugin-api-fastify/vite.config.ts", "packages/apigen/apigen-plugin-batch/vite.config.ts", "packages/apigen/apigen-plugin-cli-output/vite.config.ts", "packages/apigen/apigen-plugin-health/vite.config.ts", "packages/apigen/apigen-plugin-ir-cache/vite.config.ts", "packages/apigen/apigen-plugin-java-javalin/vite.config.ts", "packages/apigen/apigen-plugin-jsonschema/vite.config.ts", "packages/apigen/apigen-plugin-logger/vite.config.ts", "packages/apigen/apigen-plugin-mcp/vite.config.ts", "packages/apigen/apigen-plugin-openapi/vite.config.ts", "packages/apigen/apigen-plugin-py-flask/vite.config.ts", "packages/apigen/apigen-plugin-py-grpc/vite.config.ts", "packages/apigen/apigen-plugin-ts-types/vite.config.ts", "packages/apigen/codegen/openapi/vite.config.ts", "packages/apigen/python-env/vite.config.ts", "packages/data/data-base-transforms/vite.config.ts", "packages/data/data-core-structures/vite.config.ts", "packages/data/data-query-engine/vite.config.ts", "packages/dispatch/dispatch-base-spec/vite.config.ts", "packages/dispatch/dispatch-base-types/vite.config.ts", "packages/dispatch/dispatch-core-client/vite.config.ts", "packages/dispatch/dispatch-core-optimizer/vite.config.ts", "packages/dispatch/dispatch-orchestrator/vite.config.ts", "packages/dispatch/dispatch-serializer-json/vite.config.ts", "packages/environment/environment-base-spec/vite.config.ts", "packages/environment/environment-builder/vite.config.ts", "packages/environment/environment-core-node/vite.config.ts", "packages/ui-react/ui-react-base-hooks/vite.config.ts", "packages/ui-react/ui-react-base-storybook/vite.config.ts", "packages/workspace/workspace-base-standard/vite.config.ts", "packages/workspace/workspace-base-tools/vite.config.ts", "packages/workspace/workspace-base-vite-paths/vite.config.ts", "packages/workspace/workspace-codegen-nx/vite.config.ts"]
```

---

## Notes for executor

Absorb perf/test-resolve-fix. It makes the test module graph continuous across package boundaries, which is the precondition for cross-package file-level selection. Keep the 4 child-process opt-outs.
