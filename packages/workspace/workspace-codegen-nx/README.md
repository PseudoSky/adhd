# @adhd/workspace-codegen-nx

Nx generator for scaffolding golden-path `<group>-<layer>-<name>` packages following the workspace naming convention.

## Usage

```bash
nx g @adhd/workspace-codegen-nx:scaffold
```

## Generator Interface

```
nx g @adhd/workspace-codegen-nx:scaffold \
  --type <base|core|engine|store|plugin|generator|query|types|entrypoint> \
  --name <package-name> \
  --group <domain-group> \
  --nxLayer <shared|logic|data|entrypoints|...> \
  --platform <node|browser|shared> \
  [--access <domain|public>] \
  [--publish]
```

## Package <-> Directory mapping

| Layer (`--type`) | ESLint `pkg-class` | Directory pattern | Import rule |
|---|---|---|---|
| `base` | foundation | `packages/<group>/<group>-base-<name>/` | zero internal deps |
| `core` | foundation | `packages/<group>/<group>-core-<name>/` | only `base` deps |
| `engine` | foundation | `packages/<group>/<group>-engine-<name>/` | `base` + `core` deps |
| `store` | foundation | `packages/<group>/<group>-store-<name>/` | `base` + `core` deps |
| `query` | foundation | `packages/<group>/<group>-query-<name>/` | `base` + `core` deps |
| `plugin` | optional | `packages/<group>/<group>-plugin-<name>/` | `base` + `core` + `store` deps |
| `generator` | optional | `packages/<group>/<group>-generator-<name>/` | `base` + `core` deps |
| `types` | types | `packages/<group>/<group>-types/` | `access:public` only |
| `entrypoint` | entrypoint | `entrypoint/<name>/` | depends on anything in `packages/` |

## Tags applied

- `domain:<group>` — boundaries ESLint constraint
- `pkg-kind:<type>` — package kind (base/core/engine/etc.)
- `pkg-class:<class>` — ESLint enforcement class (foundation/optional/entrypoint/types)
- `layer:<nxLayer>` — architectural layer
- `platform:<platform>` — runtime environment
- `access:<domain|public>` — cross-domain import permission
- `publish:npm` — if `--publish` is set

## Post-generation patches

The generator applies the same fixes as `generate-lib.sh` v5:

1. **vite.config.ts** — adds `emptyOutDir: true`
2. **project.json** — adds `dependsOn:["build","test"]` to `nx-release-publish`
3. **README.md** — scaffolds a starter README
4. **.eslintrc.json** — adds `vite.config.*` to `ignorePatterns`
5. **tsconfig.lib.json** — adds `src/test/**` to exclude list
6. **vite.config.ts** — adds inline copy-readme plugin

## Migration from generate-lib.sh

This generator replaces `scripts/generate-lib.sh` v4. The old shell script used a hardcoded `case` statement to map layers to directories. This generator uses the explicit `--group` + `--type` parameters for the same purpose, with proper Nx integration.

| generate-lib.sh | Equivalent generator command |
|---|---|
| `./generate-lib.sh lib query-engine data shared` | `nx g ... --type core --name engine --group data --nxLayer logic --platform shared` |
| `./generate-lib.sh lib user-card ui-composites browser` | `nx g ... --type ui-composites --name card --group design-system --platform browser` |
