# builder-engine

**Phase:** builder · **Kind:** work · **Depends on:** contract-base-spec · **Guard:** `true`

---

## Goal

The `environment-builder` package has all core pipeline modules implemented: YAML parser, field definition merger, config resolver (with env var loading and `${VAR}` interpolation), JSON Schema generator, provenance tracker, validation via ajv, and atomic snapshot writer. The pipeline `buildSnapshot()` assembles them into a 17-step build process.

---

## Acceptance criteria

- [builder-engine.9] npx nx build environment-builder exits 0
---


```text
read_only:  []
mutates:    ["packages/environment/environment-builder/src/yaml-parser.ts", "packages/environment/environment-builder/src/field-merge.ts", "packages/environment/environment-builder/src/config-resolver.ts", "packages/environment/environment-builder/src/json-schema-gen.ts", "packages/environment/environment-builder/src/provenance.ts", "packages/environment/environment-builder/src/validation.ts", "packages/environment/environment-builder/src/snapshot-writer.ts", "packages/environment/environment-builder/src/index.ts"]
```

---

## Notes for executor

1. Each module is a pure function — no side effects, no shared state between pipeline steps.
2. `yaml-parser.ts` validates project.name (non-empty kebab-case) and envPrefix (uppercase).
3. `config-resolver.ts` loads `.env` hierarchy but this is deprecated in v0.0.5 — the primary store is `adhd-env set`.
4. `${VAR}` interpolation is single-level only; unresolved vars remain as literal strings.
5. The builder does NOT create directories or write snapshots — that's the `EnvironmentSnapshot` class (next state).
6. See `interfaces-architect.md` §7 for the 17-step pipeline pseudocode.