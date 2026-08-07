# builder-engine

**Phase:** builder · **Kind:** work · **Depends on:** contract-base-spec · **Guard:** `npx nx build environment-builder`

---

## Goal

The `environment-builder` package has all core pipeline modules: YAML parser, field merger, config resolver, JSON Schema generator, provenance tracker, validator, and snapshot writer. The full `buildSnapshot()` pipeline is functional.

---

## Semantic Distillation

- **Primitive:** CREATE 7 pipeline modules under `packages/environment/environment-builder/src/`

- **Reference Pattern:** Pipeline design in `interfaces-architect.md` §7 (17-step pipeline). Field merge logic in `SCOPE.md` §6 verification criteria. YAML format in SPEC_0.0.5.md.

- **Delta Spec:**
  1. `yaml-parser.ts`: `parseYamlSpec(filePath)` → `ParsedYamlSpec` — validate project.name, envPrefix, dirs, config structure
  2. `field-merge.ts`: `mergeFieldDefinitions(system, global, project)` — three-tier cascade, inheritance of validation keywords
  3. `config-resolver.ts`: resolve from env vars → set-store → defaults; `${VAR}` interpolation; `inferEnvVar(prefix, fieldPath)`
  4. `json-schema-gen.ts`: `generateFieldSchema(fields)` → nested JSON Schema from dot-path field definitions
  5. `validation.ts`: `validateConfig(config, schema)` — use ajv, throw field-level errors
  6. `provenance.ts`: `trackProvenance(resolved)` → provenance map with source/scope
  7. `snapshot-writer.ts`: atomic `.tmp` + `renameSync` write, directory creation, drift detection
  8. `index.ts`: barrel export of all public functions
  9. Verify `npx nx build environment-builder` exits 0

- **Invariants:** Each module is a pure function — no shared mutable state between pipeline steps. `${VAR}` interpolation is single-level only. No `.env` file loading (v0.0.5 constraint — use set-store).

---

## Acceptance criteria

- [builder-engine.1] Pipeline modules exist and export their functions
- [builder-engine.7] `inferEnvVar("ADHD_AGENT_MCP", "db.path")` → `"ADHD_AGENT_MCP_DB_PATH"`
- [builder-engine.9] `npx nx build environment-builder` exits 0

---

## Reservations

```text
read_only:  []
mutates:    ["packages/environment/environment-builder/src/yaml-parser.ts", "packages/environment/environment-builder/src/field-merge.ts", "packages/environment/environment-builder/src/config-resolver.ts", "packages/environment/environment-builder/src/json-schema-gen.ts", "packages/environment/environment-builder/src/provenance.ts", "packages/environment/environment-builder/src/validation.ts", "packages/environment/environment-builder/src/snapshot-writer.ts"]
```

---

## Notes for executor

1. Each module is independently testable — unit tests are expected.
2. See `interfaces-architect.md` §7 for the 17-step pipeline pseudocode.
3. The index.ts barrel export is owned by `builder-snapshot-api` — do NOT add `EnvironmentSnapshot` or `build()` exports here.
