# @adhd/workspace-codegen-nx

Nx generator for scaffolding golden-path `<group>-<layer>-<name>` packages.

## Sub-generators

Each package type has its own sub-generator:

```bash
# Library packages (require --group to determine directory)
nx g @adhd/workspace-codegen-nx:base      --name <name> --group <group> --nxLayer <layer> --platform <platform>
nx g @adhd/workspace-codegen-nx:core      --name <name> --group <group> --nxLayer <layer> --platform <platform>
nx g @adhd/workspace-codegen-nx:engine    --name <name> --group <group> --nxLayer <layer> --platform <platform>
nx g @adhd/workspace-codegen-nx:store     --name <name> --group <group> --nxLayer <layer> --platform <platform>
nx g @adhd/workspace-codegen-nx:plugin    --name <name> --group <group> --nxLayer <layer> --platform <platform>
nx g @adhd/workspace-codegen-nx:generator --name <name> --group <group> --nxLayer <layer> --platform <platform>
nx g @adhd/workspace-codegen-nx:query     --name <name> --group <group> --nxLayer <layer> --platform <platform>

# Types (minimal — always shared, always access:public, always publish:npm)
nx g @adhd/workspace-codegen-nx:types     --name <name> --group <group>

# Entrypoint (lives under entrypoint/, group is optional)
nx g @adhd/workspace-codegen-nx:entrypoint --name <name> [--platform node]
```

## Tag system

Every scaffolded package receives these tags:

| Tag | Source | Purpose | ESLint enforcement |
|---|---|---|---|
| `domain:<group>` | `--group` arg | Which bounded context the package belongs to | Cross-domain imports blocked unless dest has `access:public` |
| `pkg-kind:<type>` | sub-generator name | Package classification (base/core/engine/store/plugin/generator/query/types/entrypoint) | Human-readable, not machine-enforced |
| `pkg-class:<class>` | derived from type | Enforcement class for import rules | `foundation` → foundation+types+public, `optional` → NOT other optional, `entrypoint` → any class, `types` → public only |
| `layer:<nxLayer>` | `--nxLayer` arg | Architectural position in dep hierarchy | Controls which layers can depend on each other |
| `platform:<platform>` | `--platform` arg | Runtime environment | Browser↛Node, Node↛Browser, Shared↛only Shared |
| `access:<domain\|public>` | `--access` arg (default: `domain`) | Cross-domain import permission | Only `access:public` packages can be imported across domains |
| `publish:npm` | `--publish` flag | Published to npm registry | Not enforced (documentation) |

### pkg-class derivation

| pkg-kind | pkg-class | Import rule |
|---|---|---|
| `base` | foundation | foundation + types + `access:public` |
| `core` | foundation | foundation + types + `access:public` |
| `engine` | foundation | foundation + types + `access:public` |
| `store` | foundation | foundation + types + `access:public` |
| `query` | foundation | foundation + types + `access:public` |
| `plugin` | optional | foundation + types + `access:public`, NOT other optional |
| `generator` | optional | foundation + types + `access:public`, NOT other optional |
| `types` | types | `access:public` only |
| `entrypoint` | entrypoint | any class + `access:public`, NOT other entrypoints |

## Naming convention

```
Library:  packages/<group>/<group>-<type>-<name>/   → @adhd/<group>-<type>-<name>
Types:    packages/<group>/<group>-types/            → @adhd/<group>-types
Entrypoint: entrypoint/<name>/                       → @adhd/<name>
```

## Post-generation patches

Same six patches as the original `generate-lib.sh`:

1. **vite.config.ts** — `emptyOutDir: true`
2. **project.json** — `dependsOn:["build","test"]` on `nx-release-publish`
3. **README.md** — starter scaffold
4. **.eslintrc.json** — `vite.config.*` in `ignorePatterns`
5. **tsconfig.lib.json** — `src/test/**` in `exclude`
6. **vite.config.ts** — inline copy-readme plugin

## Examples

```bash
# Create a new query engine in the data group
nx g @adhd/workspace-codegen-nx:query --name engine --group data --nxLayer logic --platform shared

# Create a plugin for the agent group
nx g @adhd/workspace-codegen-nx:plugin --name budget --group agent --nxLayer logic --platform node

# Create shared types for the dispatch group
nx g @adhd/workspace-codegen-nx:types --name shared --group dispatch

# Create a CLI entrypoint
nx g @adhd/workspace-codegen-nx:entrypoint --name my-cli
```
