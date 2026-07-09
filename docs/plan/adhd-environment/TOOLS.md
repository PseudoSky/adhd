# TOOLS — adhd-environment v0.0.5

Capability inventory, build-vs-reuse verdicts, and interface contracts for every tool.

## 1. Capability list

| # | Capability | Description |
|---|---|---|
| C1 | YAML parsing | Parse `adhd.environment.yaml` into a typed spec object |
| C2 | `.env` file parser | Parse `KEY=VALUE` files (internal, zero deps) |
| C3 | SHA-256 hashing | Content-addressed hashes (config + structure) |
| C4 | Atomic file writes | `.tmp` + `renameSync` — never partial on disk |
| C5 | `${VAR}` interpolation | Single-level env var expansion in strings |
| C6 | Directory creation | `mkdir -p`, idempotent |
| C7 | JSON read/write | Read/write prettified snapshot JSON |
| C8 | JSON Schema validation (TS) | Validate resolved config against `fieldSchema` |
| C9 | JSON Schema validation (Python) | Same, using `jsonschema` library |
| C10 | JSON Schema validation (Rust) | Same, using `jsonschema` crate |
| C11 | CLI code generation | apigen: Commander CLI from scalar-param exports |
| C12 | Nx build orchestration | Build, test, lint for 6 packages across 3 languages |
| C13 | Python JSON read/write | stdlib `json` module |
| C14 | Rust JSON read/write | `serde` + `serde_json` |
| C15 | Rust SHA-256 | `sha2` crate |
| C16 | `EnvironmentSnapshot` builder class | Build/set/get/configPath/write API on builder-produced instances |
| C17 | CLI `set` command | `adhd-env set <path> <value> [--namespace <ns>]` — stores config values without `.env` file |

## 2. Existing inventory

| Capability | Existing tool | Location |
|---|---|---|
| C1 | `yaml` npm package | npm, 5M+ weekly downloads |
| C2 | None — internal (~40 lines) | `environment-builder/src/parse-env-file.ts` |
| C3 | `node:crypto`, Python `hashlib`, Rust `sha2` | Built-in / standard crate |
| C4 | `node:fs`, Python `tempfile`, Rust `tempfile` | Built-in / standard crate |
| C5 | None — internal (~30 lines) | `environment-builder/src/interpolate.ts` |
| C6 | `node:fs.mkdirSync(recursive)` | Node.js built-in |
| C7 | `node:fs`, Python `json`, Rust `serde_json` | Built-in |
| C8 | `ajv` | npm, 40M+ weekly downloads |
| C9 | `jsonschema` | PyPI, 20M+ monthly downloads |
| C10 | `jsonschema` crate | crates.io |
| C11 | `@adhd/apigen` | Monorepo: `packages/apigen/` |
| C12 | `nx` | Monorepo root |
| C16 | None — must build | `environment-builder/src/environment-snapshot.ts` |
| C17 | None — must build | `entrypoint/environment-cli/src/commands/set.ts` |
| C13 | Python stdlib `json` | Built-in |
| C14 | `serde` + `serde_json` | crates.io |
| C15 | `sha2` crate | crates.io |

## 3. Gap analysis

| Capability | Provider | Coverage | Gap |
|---|---|---|---|---|
| C1 | `yaml` | 100% | `npm install yaml` — builder package only |
| C2 | Internal | **deprecated (v0.0.5)** | Replaced by `adhd-env set` and `adhd-env build` — no `.env` file workflow |
| C5 | Internal | 0% (must build) | ~30 lines |
| C8 | `ajv` | 100% | `npm install ajv` — builder package only |
| C9 | `jsonschema` (Python) | 100% | `pip install jsonschema` |
| C10 | `jsonschema` (Rust) | 100% | Add to Cargo.toml |
| C16 | Internal | 0% (must build) | `EnvironmentSnapshot` class with build/set/get/configPath/write |
| C17 | Internal | 0% (must build) | CLI `set` command wrapping the builder's store |
| All others | Built-in or existing | 100% | No gap |

## 4. Build-vs-reuse verdict per gap

| Capability | Verdict | Rationale |
|---|---|---|---|
| C1 YAML parser | **Reuse** (`yaml` package) | Well-established, used only in builder package (not runtime). |
| C2 `.env` parser | **Removed (v0.0.5)** | No `.env` file workflow. Replaced by `adhd-env set` + builder store. |
| C5 `${VAR}` interpolator | **Build** | ~30 lines. Simple regex. "Leave unresolved as literal" fallback no library replicates. |
| C8 `ajv` | **Reuse** | Standard JSON Schema validator. Builder-only dep. |
| C9 `jsonschema` Python | **Reuse** | Standard Python JSON Schema validator. Runtime dep for Python client. |
| C10 `jsonschema` Rust | **Reuse** | Standard Rust JSON Schema validator crate. Runtime dep for Rust client. |
| C16 `EnvironmentSnapshot` | **Build** | Core builder class with `.set()`, `.get()`, `.configPath`, `.write()` instance methods. `build()` factory function returns typed instance. |
| C17 CLI `set` | **Build** | Wraps the builder store. `adhd-env set <field> <value> [--namespace <ns>]` — persists value for next build. |

## 5. Interface contracts

### C1: `parseYamlSpec(filePath: string): ParsedYamlSpec`

```
Signature:    parseYamlSpec(filePath: string): ParsedYamlSpec
Input:        Path to adhd.environment.yaml
Output:       Typed spec object with project, namespaces, dirs, config
Deps:         yaml npm package

Validates:
  - project.name is required, non-empty
  - project.envPrefix is required, matches /^[A-Z][A-Z0-9_]*$/
  - dirs[].type matches DirectoryType pattern
  - config.{system,global,project} fields have valid types and keywords

Error surface:
  - ENOENT: throws with file path
  - YAML parse error: throws with line number
  - Validation error: throws with field path + message
```

### C2: `parseEnvFile(filePath: string): Record<string, string>`

```
Pure function. Returns key→value map. Never mutates process.env.
Parsing: skips blank/# lines, splits on first =, strips export prefix, strips matching quotes.
${VAR} preserved as literal. ENOENT → {}.
```

### C3: `contentHash(config: Record<string, string>): string`

```
Sorted key=value\n (byte-order). SHA-256. "sha256-" + hex.
Test vector: {b:"2",a:"1"} → "sha256-66e4efebc74d002dabcf821c0ee1402726e5c9d25a8469e7fc3f7d7691464788"
```

### C5: `inferEnvVar(prefix: string, fieldPath: string): string`

```
Signature:    inferEnvVar(prefix: string, fieldPath: string): string
Algorithm:
  1. Uppercase fieldPath
  2. Replace "." with "_"
  3. Prepend prefix + "_"
Examples:
  inferEnvVar("ADHD_AGENT_MCP", "db.path") → "ADHD_AGENT_MCP_DB_PATH"
  inferEnvVar("ADHD_AGENT_MCP", "providers.deepseek.secret") → "ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_SECRET"
```

### C8: `validateConfig(nested: object, fieldSchema: object): void`

```
TypeScript: ajv.compile(fieldSchema)(nested)
Python:     jsonschema.validate(nested, fieldSchema)
Rust:       jsonschema::validator_for(&fieldSchema).validate(&nested)

All three: throws if validation fails. Error includes field path + constraint violation.
If fieldSchema is absent or empty: skip validation (no fields defined).
```

### C16: `build(spec: ProjectConfig | EnvironmentSnapshot, options?: BuildOptions): EnvironmentSnapshot<T>`

```
Factory function. Returns an EnvironmentSnapshot instance with instance methods.

Signature:    build<T>(spec: ProjectConfig | EnvironmentSnapshot, options?: BuildOptions): EnvironmentSnapshot<T>
Input:
  - spec: ParsedYamlSpec (from YAML) or existing EnvironmentSnapshot (to rebuild)
  - options: { namespace?, scope?, adhdRoot?, configPath?, dryRun? }

EnvironmentSnapshot<T> instance:
  - .get<K extends keyof T>(path: K): T[K]           — typed getter
  - .set<K extends keyof T>(path: K, value: T[K]): void  — typed setter (in-memory)
  - .get<K>(path: string): unknown                    — untyped fallback
  - .set(path: string, value: unknown): void           — raw setter
  - .configPath: string                                — resolved output path
  - .write(): void                                     — validate + atomic write
  - .write({ skipValidation?: boolean }): void          — force write option

Errors:
  - set(): always succeeds in memory
  - write(): throws ValidationError if config fails fieldSchema validation
  - write(): never creates partial file (atomic .tmp + renameSync)

Path resolution:
  - With namespace: ~/.<orgNamespace>/<project>/<namespace>/adhd-environment.json
  - Without namespace: ~/.<orgNamespace>/<project>/adhd-environment.json
  - orgNamespace defaults to "adhd"
```

### Builder pipeline: `buildSnapshot(spec: ParsedYamlSpec, options: BuildOptions): EnvironmentSnapshot`

```
17-step pipeline:
  1. Parse YAML → ParsedYamlSpec
  2. Load .env files (configurable hierarchy from options.envFiles or default)
  3. Merge field definitions (system → global → project)
  4. For each field without explicit env: infer env var name
  5. Resolve each field: env var → process.env → default
  6. Interpolate ${VAR} references in resolved values
  7. unflatten(raw) → nested config
  8. Type-coerce values per field definitions
  9. Generate fieldSchema from merged definitions
  10. Validate nested config against fieldSchema (ajv)
  11. Compute contentHash(raw)
  12. Compute structureHash(dirs)
  13. Track provenance for every resolved field
  14. Read existing snapshot, compare structureHash → detect drift
  15. Ensure all directories exist on disk
  16. Atomic write snapshot to <adhdRoot>/<project>/<namespace>/adhd-environment.json
  17. Return EnvironmentSnapshot
```

## 6. Dependency graph

```
environment-base-spec      — no deps
environment-builder        — depends on: yaml, ajv, environment-base-spec (types)
environment-core-node      — depends on: environment-base-spec (types only)
environment-cli            — depends on: environment-builder, environment-core-node, apigen
environment-core-py        — depends on: jsonschema, pyyaml (for snapshot reading)
environment-core-rs        — depends on: serde, serde_json, sha2, jsonschema

Build order: base-spec → builder → core-node + cli (TS) || core-py + core-rs (parallel)
```

## 7. Validation methods

| Tool | Validation | Valid as of |
|---|---|---|
| C1 YAML parser | Round-trip: parse → validate → no errors | (post-implementation) |
| C3 contentHash | Test vector gate | 2026-07-06 |
| C5 inferEnvVar | Contract test vectors (3 examples) | 2026-07-06 |
| C8 ajv | Valid config passes, invalid throws with field-level errors | (post-implementation) |
| C9 jsonschema (Python) | Same test vectors as TS | (post-implementation) |
| C10 jsonschema (Rust) | Same test vectors as TS | (post-implementation) |
| C11 apigen CLI | `npx nx generate-cli environment-cli` → valid TS output | 2026-07-06 |
| C16 EnvironmentSnapshot | `build() → instance with set()/get()/configPath/write()`, round-trip test | (post-implementation) |
| C17 CLI set | `adhd-env set X Y --namespace Z` → stored, `build --namespace Z` → resolved | (post-implementation) |
| Builder pipeline | `build(spec, opts)` → valid EnvironmentSnapshot, passes schema validation | (post-implementation) |
