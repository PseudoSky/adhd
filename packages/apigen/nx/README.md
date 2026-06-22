# @adhd/apigen-nx

Nx integration for apigen: a **generator** to scaffold new output plugins and a
**cache-aware executor** to run `apigen generate` as a first-class Nx target.

Part of [apigen](../README.md).

## Generator — `plugin`

Scaffold a new `@adhd/apigen-plugin-*` package with correct Nx tags
(`layer:logic, platform:node`) and tsconfig/build wiring:

```bash
npx nx g @adhd/apigen-nx:plugin <name> --directory packages/apigen/plugins/<name>
npx nx build apigen-plugin-<name>
```

The scaffold implements the `OutputPlugin` contract from
[`@adhd/apigen-core`](../core) so it's ready to `generate` (and optionally `run`).

## Executor — `generate`

Run `@adhd/apigen-cli generate` as a cache-aware Nx target. Wire it into a project's
`project.json`:

```jsonc
{
  "targets": {
    "generate-api": {
      "executor": "@adhd/apigen-nx:generate",
      "options": { "source": "src/api.ts", "type": "mcp", "outDir": "dist/api" }
    }
  }
}
```

```bash
npx nx run <project>:generate-api    # second run is an Nx cache hit (byte-identical output)
```

## Develop

```bash
npx nx build apigen-nx
npx nx test  apigen-nx
```
