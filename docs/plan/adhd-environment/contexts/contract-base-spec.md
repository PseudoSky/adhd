# contract-base-spec — STATE_NAME

**Phase:** contract · **Kind:** work · **Depends on:** scaffold-workspace · **Guard:** `true`

---

## Goal

The `environment-base-spec` package is fully scaffolded with the canonical JSON Schema for the snapshot format, cross-language test vectors, and TypeScript type re-exports. This is the contract that all other packages build against — snapshot format, field types, scope values, directory types, and provenance shapes are all frozen here.

---

## Acceptance criteria


- [contract-base-spec.1] Snapshot schema validates against JSON Schema meta-schema (draft-07)
- [contract-base-spec.2] cross-language-test-vectors.json exists with contentHash gate test vector
- [contract-base-spec.3] index.ts exports EnvironmentSnapshot, ProjectIdentity, ConfigFieldDefinition, ProvenanceEntry, DirectoryEntry, DirectoryType, ConfigScope, FieldType, ProvenanceSource
---

## Reservations

```text
read_only:  []
mutates:    ["packages/environment/environment-base-spec/spec/adhd-environment.schema.json", "packages/environment/environment-base-spec/spec/cross-language-test-vectors.json", "packages/environment/environment-base-spec/spec/SPEC.md", "packages/environment/environment-base-spec/src/index.ts"]
```

---

## Notes for executor

1. The schema file is the single source of truth — TypeScript types in `src/index.ts` are generated FROM it (use `ts-json-schema-generator` or manual mirroring).
2. Test vectors are the cross-language gate: every language client must pass the same vectors.
3. Implement `contentHash()` in `src/index.ts` — sorted `key=value\n`, SHA-256, `"sha256-"+hex` prefix.
4. See `docs/plan/adhd-environment/interfaces-architect.md` §2 for exact type definitions.
