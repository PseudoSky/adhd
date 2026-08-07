# scaffold-workspace

**Phase:** scaffold · **Kind:** work · **Depends on:** none · **Guard:** `test -f packages/environment/environment-base-spec/package.json && test -f entrypoint/environment-cli/package.json`

---

## Goal

All 6 package directories exist under `packages/environment/` with their Nx workspace configuration (project.json, package.json, tsconfig.json for TS packages; pyproject.toml for Python; Cargo.toml for Rust). tsconfig.base.json has path mappings for each package. The monorepo can build each package through Nx.

---

## Semantic Distillation

- **Primitive:** CREATE 6 packages under `packages/environment/` + 1 entrypoint under `entrypoint/environment-cli/`

- **Reference Pattern:** See `packages/dispatch/dispatch-core-client/` and `entrypoint/apigen-cli/` for naming conventions. Use `@adhd/workspace-codegen-nx` generators (NOT `@nx/js:library`).

- **Delta Spec:** 
  1. `npm install -D @monodon/rust @nxlv/python`
  2. Add `{ "plugin": "@monodon/rust" }` and `{ "plugin": "@nxlv/python" }` to nx.json plugins array (preserve existing entries)
  3. Run 4 workspace-codegen-nx generators (see below for exact commands)
  4. Hand-write Python `pyproject.toml` + `project.json` with `@nxlv/python:build`/`publish` targets
  5. Hand-write Rust `Cargo.toml` + `project.json` with `@monodon/rust:build`/`test`/`lint` targets
  6. Add 4 path mappings to `tsconfig.base.json` `compilerOptions.paths`
  7. Verify `npx nx build environment-base-spec` exits 0

- **Invariants:** Do NOT modify existing packages outside `packages/environment/` or `entrypoint/environment-cli/`. Do NOT remove existing nx.json plugin entries.

---

## Acceptance criteria

- [scaffold-workspace.1] All 5 library package directories exist under packages/environment/
- [scaffold-workspace.2] CLI entrypoint directory exists at entrypoint/environment-cli/
- [scaffold-workspace.3] nx.json has @monodon/rust and @nxlv/python plugins registered
- [scaffold-workspace.4] `environment-core-node` package.json `name` is `@adhd/environment` (B3: NOT the generator default `@adhd/environment-core-node`) and `tsconfig.base.json` aliases `@adhd/environment` → its src/index.ts

---

## Reservations

```text
read_only:  []
mutates:    ["packages/environment/environment-base-spec/package.json", "packages/environment/environment-base-spec/project.json", "packages/environment/environment-base-spec/tsconfig.json", "packages/environment/environment-builder/package.json", "packages/environment/environment-builder/project.json", "packages/environment/environment-builder/tsconfig.json", "packages/environment/environment-core-node/package.json", "packages/environment/environment-core-node/project.json", "packages/environment/environment-core-node/tsconfig.json", "entrypoint/environment-cli/package.json", "entrypoint/environment-cli/project.json", "entrypoint/environment-cli/tsconfig.json", "packages/environment/environment-core-py/pyproject.toml", "packages/environment/environment-core-rs/Cargo.toml", "packages/environment/environment-core-rs/Cargo.lock", "tsconfig.base.json"]
```

---

## Nx generator commands

Run these from monorepo root to scaffold all 6 packages:

### TypeScript packages (under `packages/environment/`)

Use the workspace generator `@adhd/workspace-codegen-nx` — NOT `@nx/js:library`. The workspace generator handles the correct project.json, tags, and Nx configuration for this monorepo.

```bash
# environment-base-spec — pure types/contract package, roots of dep graph
npx nx generate @adhd/workspace-codegen-nx:types \
  --group environment --name base-spec

# environment-builder — core logic package (depends only on base packages)
npx nx generate @adhd/workspace-codegen-nx:core \
  --group environment --name builder \
  --nxLayer logic --platform node --access public --publish true

# environment-core-node — core runtime package 
npx nx generate @adhd/workspace-codegen-nx:core \
  --group environment --name core-node \
  --nxLayer shared --platform node --access public --publish true
```

> **⚠️ Package identity override (B3, required).** The `core` generator names this package
> `@adhd/environment-core-node` by the `<group>-<name>` convention. This is the published runtime
> client whose npm name is **`@adhd/environment`** (SCOPE.md §3 constraint "npm name `@adhd/environment`",
> interfaces-architect.md §4). After generating, **edit `packages/environment/environment-core-node/package.json`
> and set `"name": "@adhd/environment"`**. If it is left as `@adhd/environment-core-node`, the final-audit
> probes `require("@adhd/environment")` (dod.5/dod.6) throw MODULE_NOT_FOUND. The matching
> `tsconfig.base.json` alias `@adhd/environment` → `packages/environment/environment-core-node/src/index.ts`
> is declared below — the runtime `require()` resolution depends on the package.json `name`, so both must agree.

Generator layer reference:
- `types` → for pure type/contract packages (like `*-types`)
- `base` → zero internal deps, roots of the dep graph
- `core` → depends only on base packages
- `engine` → orchestration/wiring
- `store` → persistence/storage
- `entrypoint` → CLI/server/runner (lives under `entrypoint/`)

### CLI endpoint (under `entrypoint/`)

```bash
npx nx generate @adhd/workspace-codegen-nx:entrypoint \
  --name environment-cli \
  --nxLayer entrypoints --platform node --access public --publish true
```

After scaffold, add the apigen `generate-cli` target to `entrypoint/environment-cli/project.json`:
```json
"generate-cli": {
  "executor": "@adhd/apigen-generator-nx:generate",
  "options": {
    "source": "entrypoint/environment-cli/src/api.ts",
    "type": "cli",
    "outDir": "dist/entrypoint/environment-cli/cli"
  }
}
```

### Step 1: Install Nx plugins

```bash
npm install -D @monodon/rust @nxlv/python
```

`@monodon/rust` (12k weekly) provides `@monodon/rust:build/test/lint` executors for Rust.
`@nxlv/python` (205k weekly) provides `@nxlv/python:build/publish` executors, Poetry/Uv support, and full Nx release `versionActions` for Python.

### Step 2: Configure nx.json

Add plugin registrations and named inputs to `nx.json`:
```json
{
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": ["default", "!{projectRoot}/**/*.test.*", "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)"],
    "sharedGlobals": []
  },
  "plugins": [
    { "plugin": "@monodon/rust" },
    { "plugin": "@nxlv/python", "options": { "packageManager": "poetry" } }
  ],
  "generators": {
    "@nxlv/python:poetry-project": {
      "linter": "ruff",
      "unitTestRunner": "pytest"
    }
  }
}
```

The `@monodon/rust` and `@nxlv/python` plugins auto-register their executors so Nx can resolve `@monodon/rust:build`, `@nxlv/python:build`, etc. in project.json targets.

No separate `namedInputs` for python/rust needed — the plugins handle input inference. The `externalDependencies: []` pattern (preventing pnpm-lock.yaml cross-contamination) is handled by the plugins' default input sets.

### Python package

```bash
# Create package directory
mkdir -p packages/environment/environment-core-py/src/adhd_environment
mkdir -p packages/environment/environment-core-py/tests
```

Create `packages/environment/environment-core-py/pyproject.toml`:
```toml
[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "adhd-environment"
version = "0.0.1"
description = "Python runtime client for @adhd/environment"
readme = "README.md"
requires-python = ">=3.10"
license = { text = "MIT" }
dependencies = []
optional-dependencies = { dev = ["pytest>=7.0", "jsonschema>=4.0"] }

[tool.setuptools.packages.find]
where = ["src"]
include = ["adhd_environment*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Create `packages/environment/environment-core-py/project.json` — publishable to PyPI via `@nxlv/python`:
```json
{
  "name": "environment-core-py",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "projectType": "library",
  "sourceRoot": "packages/environment/environment-core-py/src",
  "tags": ["domain:environment", "layer:shared", "platform:python", "publish:pypi"],
  "implicitDependencies": ["environment-base-spec"],
  "release": {
    "version": {
      "versionActions": "@nxlv/python/release/version-actions"
    }
  },
  "targets": {
    "build": {
      "executor": "@nxlv/python:build",
      "outputs": ["{workspaceRoot}/dist/packages/environment/environment-core-py"],
      "options": {
        "outputPath": "dist/packages/environment/environment-core-py",
        "publish": true,
        "lockedVersions": false,
        "bundleLocalDependencies": false
      }
    },
    "test": {
      "executor": "@nxlv/python:run-commands",
      "options": {
        "command": "pytest tests/ -v",
        "cwd": "{projectRoot}"
      }
    },
    "lint": {
      "executor": "@nxlv/python:flake8",
      "options": { "outputFile": "{projectRoot}/lint-results.txt" }
    },
    "nx-release-publish": {
      "executor": "@nxlv/python:publish",
      "options": { "buildTarget": "build" },
      "dependsOn": ["build"]
    }
  }
}
```

Create `packages/environment/environment-core-py/src/adhd_environment/__init__.py` and `environment.py`.

### Rust package

```bash
mkdir -p packages/environment/environment-core-rs/src
```

Create `packages/environment/environment-core-rs/Cargo.toml`:
```toml
[package]
name = "adhd-environment"
version = "0.0.1"
edition = "2021"
description = "Rust runtime client for @adhd/environment"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"

[dev-dependencies]
tempfile = "3"

[profile.release]
opt-level = 2
```

Create `packages/environment/environment-core-rs/project.json` — publishable to crates.io via `@monodon/rust`:
```json
{
  "name": "environment-core-rs",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "projectType": "library",
  "sourceRoot": "packages/environment/environment-core-rs/src",
  "tags": ["domain:environment", "layer:shared", "platform:rust", "publish:crates"],
  "implicitDependencies": ["environment-base-spec"],
  "targets": {
    "build": {
      "executor": "@monodon/rust:build",
      "outputs": ["{workspaceRoot}/dist/packages/environment/environment-core-rs"],
      "options": {
        "release": true,
        "targetDir": "dist/packages/environment/environment-core-rs"
      },
      "inputs": ["production", "^production"],
      "dependsOn": ["^build"]
    },
    "test": {
      "executor": "@monodon/rust:test",
      "options": {}
    },
    "lint": {
      "executor": "@monodon/rust:lint",
      "options": {}
    },
    "nx-release-publish": {
      "executor": "nx:run-commands",
      "options": {
        "command": "cargo publish --token $CARGO_REGISTRY_TOKEN",
        "cwd": "{projectRoot}"
      },
      "dependsOn": ["build"]
    }
  }
}
```

For the Rust `nx-release-publish`, set `useLegacyVersioning: true` in the `nx.json` `release.version` section — `@monodon/rust` doesn't yet implement the new VersionActions API. This tells Nx to use the legacy version generator which handles Cargo.toml version bumps directly:
```json
// in nx.json → release → version
"useLegacyVersioning": true
```

### Nx dependency graph

```
environment-base-spec ──┬── environment-builder (implicitDeps: base-spec)
                        ├── environment-core-node (implicitDeps: base-spec)
                        ├── environment-core-py   (implicitDeps: base-spec)
                        └── environment-core-rs   (implicitDeps: base-spec)

environment-builder ──── environment-cli (dependsOn: ^build)
environment-core-node ── environment-cli (dependsOn: ^build)
```

- `command` targets use the shell directly (no executor), making them language-agnostic.
- `inputs` reference named inputs (`python`, `rust`) that exclude external deps, so pnpm-lock.yaml changes never flag Python/Rust as affected.
- `dependsOn: ["^build"]` on test targets ensures dependencies build first.
- `implicitDependencies` registers cross-language edges Nx cannot auto-detect.
- `cache: true` on Rust build enables Nx computation caching for `cargo build`.

### tsconfig.base.json path mappings

Add these 4 entries under `compilerOptions.paths` (note: `@adhd/environment` maps to the `environment-core-node` package dir but is published under the name `@adhd/environment` — see the B3 override above):
```json
"@adhd/environment-base-spec": ["packages/environment/environment-base-spec/src/index.ts"],
"@adhd/environment-builder": ["packages/environment/environment-builder/src/index.ts"],
"@adhd/environment": ["packages/environment/environment-core-node/src/index.ts"],
"@adhd/environment-cli": ["entrypoint/environment-cli/src/index.ts"]
```

### Nx tags convention

Follow the existing monorepo tag pattern used by dispatch-* and workspace-* packages:
```json
"tags": ["domain:environment", "pkg-kind:<kind>", "pkg-class:<class>", "layer:<layer>", "platform:<platform>", "access:public", "publish:npm|pypi|crates"]
```

Per-package tags:

| Package | pkg-kind | pkg-class | layer | platform | publish |
|---------|----------|-----------|-------|----------|---------|
| environment-base-spec | spec | contract | foundation | shared | npm |
| environment-builder | engine | logic | logic | node | npm |
| environment-core-node | runtime | shared | shared | node | npm |
| environment-cli | cli | entrypoint | presentation | node | npm |
| environment-core-py | runtime | shared | shared | python | pypi |
| environment-core-rs | runtime | shared | shared | rust | crates |

### Detailed reference

See `docs/plan/adhd-environment/interfaces-architect.md` §3–5 for exact project.json structures, tsconfig settings, and per-package file trees.
