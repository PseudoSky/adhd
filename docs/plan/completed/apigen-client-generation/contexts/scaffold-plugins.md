# scaffold-plugins — SCAFFOLD 5 PLUGIN PACKAGES VIA GENERATOR

**Phase:** plugins · **Depends on:** nx-generator, audit-runtime · **Guard:** `node -e "const fs=require('fs'); ['packages/apigen/plugins/jsonschema','packages/apigen/plugins/mcp','packages/apigen/plugins/api-fastify','packages/apigen/plugins/api-express','packages/apigen/plugins/cli'].forEach(d=>{if(!fs.existsSync(d+'/project.json')||!fs.existsSync(d+'/src/lib/plugin.ts'))throw new Error('missing: '+d)})"`

---

## Goal

Use the `@adhd/apigen-nx:plugin` generator (built in `nx-generator`) to scaffold all 5 plugin packages. After this state, every plugin has a valid Nx project, correct tags, wired tsconfig path, and a typed `OutputPlugin` stub. No implementation — just the skeleton. The subsequent `plugin-api-fastify` state fills in the first real implementation.

This is the generator being used on its actual intended targets, not a test dummy. If the generator has a bug, it surfaces here before any plugin is implemented.

---

## Semantic Distillation

- **Primitive:** Run `nx g @adhd/apigen-nx:plugin` × 5 against the live workspace.
- **Delta Spec:**

```bash
# jsonschema — generate-only, no run()
npx --yes nx g @adhd/apigen-nx:plugin \
  --name jsonschema \
  --description "Emit one JSON Schema file per function per package" \
  --hasRun false \
  --no-interactive

# mcp — needs run() (stdio/SSE/streaming-HTTP server)
npx --yes nx g @adhd/apigen-nx:plugin \
  --name mcp \
  --description "Expose functions as MCP tools (stdio, SSE, or streaming-HTTP)" \
  --hasRun true \
  --no-interactive

# api-fastify — needs run() (in-process Fastify server)
npx --yes nx g @adhd/apigen-nx:plugin \
  --name api-fastify \
  --description "Expose functions as Fastify HTTP POST routes" \
  --hasRun true \
  --no-interactive

# api-express — needs run() (in-process Express server)
npx --yes nx g @adhd/apigen-nx:plugin \
  --name api-express \
  --description "Expose functions as Express HTTP POST routes" \
  --hasRun true \
  --no-interactive

# cli-output — generate-only, no run()
npx --yes nx g @adhd/apigen-nx:plugin \
  --name cli-output \
  --description "Emit a Commander CLI program for each exported function" \
  --hasRun false \
  --no-interactive
```

After all 5 invocations:

```bash
npx --yes nx reset  # clear project graph cache so all 5 new packages are registered
npx --yes nx show projects | grep apigen-plugin  # verify 5 plugin projects appear
```

Verify `tsconfig.base.json` has all 5 new paths (added automatically by generator):
```bash
node -e "const p=require('./tsconfig.base.json').compilerOptions.paths;
['@adhd/apigen-plugin-jsonschema','@adhd/apigen-plugin-mcp','@adhd/apigen-plugin-api-fastify','@adhd/apigen-plugin-api-express','@adhd/apigen-plugin-cli-output'].forEach(k=>{
  if(!p[k]) throw new Error('missing tsconfig path: '+k)
})"
```

### What the generator produces per plugin

Each invocation creates:
```
packages/apigen/plugins/<name>/
├── project.json          — tags: [layer:logic, platform:node], build+test+nx-release-publish targets
├── package.json          — @adhd/apigen-plugin-<name>, deps: @adhd/apigen-core + @adhd/apigen-runtime
├── vite.config.ts        — Nx default (no emptyOutDir needed — generator sets it in project.json)
├── src/
│   ├── index.ts          — re-exports the plugin
│   ├── lib/
│   │   └── plugin.ts     — OutputPlugin stub (with or without run() depending on --hasRun)
│   └── test/
│       └── plugin.spec.ts — interface smoke test
```

And `tsconfig.base.json` is updated with the new `@adhd/apigen-plugin-<name>` path.

### Verify the stubs compile

After scaffolding, a quick build check proves the TypeScript is valid:
```bash
npx --yes nx run-many --target=build \
  --projects=apigen-plugin-jsonschema,apigen-plugin-mcp,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output
```

All 5 should build (stubs return `{ files: [] }` — valid). If any fail, fix the generator before proceeding to implementation.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/plugins/jsonschema/project.json",
            "packages/apigen/plugins/jsonschema/package.json",
            "packages/apigen/plugins/jsonschema/src/lib/plugin.ts",
            "packages/apigen/plugins/jsonschema/src/index.ts",
            "packages/apigen/plugins/mcp/project.json",
            "packages/apigen/plugins/mcp/package.json",
            "packages/apigen/plugins/mcp/src/lib/plugin.ts",
            "packages/apigen/plugins/mcp/src/index.ts",
            "packages/apigen/plugins/api-fastify/project.json",
            "packages/apigen/plugins/api-fastify/package.json",
            "packages/apigen/plugins/api-fastify/src/lib/plugin.ts",
            "packages/apigen/plugins/api-fastify/src/index.ts",
            "packages/apigen/plugins/api-express/project.json",
            "packages/apigen/plugins/api-express/package.json",
            "packages/apigen/plugins/api-express/src/lib/plugin.ts",
            "packages/apigen/plugins/api-express/src/index.ts",
            "packages/apigen/plugins/cli/project.json",
            "packages/apigen/plugins/cli/package.json",
            "packages/apigen/plugins/cli/src/lib/plugin.ts",
            "packages/apigen/plugins/cli/src/index.ts",
            "tsconfig.base.json"]
read_only:  ["packages/apigen/nx/"]
```

---

## Acceptance criteria

- `[scaffold-plugins.1]` All 5 plugin `project.json` files exist with `"tags": ["layer:logic", "platform:node"]`:
  ```bash
  for name in jsonschema mcp api-fastify api-express cli; do
    d="packages/apigen/plugins/$name"
    node -e "const j=require('./$d/project.json'); const t=j.tags; if(!t.includes('layer:logic')||!t.includes('platform:node')) throw new Error('wrong tags in $d')"
  done
  ```

- `[scaffold-plugins.2]` All 5 packages appear in `nx show projects`:
  ```bash
  npx --yes nx show projects | grep -c apigen-plugin
  # Expected: 5
  ```

- `[scaffold-plugins.3]` `tsconfig.base.json` has all 5 plugin path entries:
  ```bash
  node -e "const p=require('./tsconfig.base.json').compilerOptions.paths; ['@adhd/apigen-plugin-jsonschema','@adhd/apigen-plugin-mcp','@adhd/apigen-plugin-api-fastify','@adhd/apigen-plugin-api-express','@adhd/apigen-plugin-cli-output'].forEach(k=>{if(!p[k])throw new Error('missing: '+k)})"
  ```

- `[scaffold-plugins.4]` `mcp`, `api-fastify`, `api-express` stubs contain `run()` method; `jsonschema`, `cli-output` stubs do not:
  ```bash
  grep -l "run(" packages/apigen/plugins/mcp/src/lib/plugin.ts packages/apigen/plugins/api-fastify/src/lib/plugin.ts packages/apigen/plugins/api-express/src/lib/plugin.ts | wc -l
  # Expected: 3
  grep -L "run(" packages/apigen/plugins/jsonschema/src/lib/plugin.ts packages/apigen/plugins/cli/src/lib/plugin.ts | wc -l
  # Expected: 2
  ```

- `[scaffold-plugins.5]` All 5 plugin stubs build cleanly (TypeScript valid, interface satisfied):
  ```bash
  npx --yes nx run-many --target=build --projects=apigen-plugin-jsonschema,apigen-plugin-mcp,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output
  ```

---

## Commit points

1. After all 5 generators run and build passes: `feat(apigen): scaffold 5 plugin packages via @adhd/apigen-nx generator`
