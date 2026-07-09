# contract-base-spec

**Phase:** contract · **Kind:** work · **Depends on:** scaffold-workspace · **Guard:** `npx nx build environment-base-spec`

---

## Goal

The `environment-base-spec` package is fully scaffolded with the canonical JSON Schema for the snapshot format, cross-language test vectors, and TypeScript type re-exports. This is the contract that all other packages build against.

---

## Semantic Distillation

- **Primitive:** CREATE `adhd-environment.schema.json`, `cross-language-test-vectors.json`, and `src/index.ts`

- **Reference Pattern:** Schema format derived from SPEC_0.0.5.md. Type types mirror those in `interfaces-architect.md` §2.

- **Delta Spec:**
  1. Write `spec/adhd-environment.schema.json` with all sections: project, namespace, version, directories, config, fieldSchema, provenance, envPrefix, envVars
  2. Write `spec/cross-language-test-vectors.json` with contentHash test vector: `{b:"2",a:"1"}` → `"sha256-66e4efebc74d002dabcf821c0ee1402726e5c9d25a8469e7fc3f7d7691464788"`
  3. Write `src/index.ts` exporting: EnvironmentSnapshot, ProjectIdentity, ConfigFieldDefinition, ProvenanceEntry, DirectoryEntry, DirectoryType, ConfigScope, FieldType, ProvenanceSource, contentHash()
  4. Write `spec/SPEC.md` documenting the contract format
  5. Verify `npx nx build environment-base-spec` exits 0

- **Invariants:** Schema is the single source of truth — TypeScript types must match schema exactly. Test vectors are the cross-language gate — never change without updating all 3 language clients.

---

## Acceptance criteria

- [contract-base-spec.1] Schema file validates against JSON Schema meta-schema
- [contract-base-spec.2] Cross-language test vectors exist with contentHash gate
- [contract-base-spec.3] index.ts re-exports shared types
- [contract-base-spec.5] `npx nx build environment-base-spec` exits 0

---

## Reservations

```text
read_only:  []
mutates:    ["packages/environment/environment-base-spec/spec/adhd-environment.schema.json", "packages/environment/environment-base-spec/spec/cross-language-test-vectors.json", "packages/environment/environment-base-spec/spec/SPEC.md", "packages/environment/environment-base-spec/src/index.ts"]
```

---

## Notes for executor

1. The schema file is the single source of truth — TypeScript types are generated FROM it.
2. Implement `contentHash()` — sorted `key=value\n`, SHA-256, `"sha256-"+hex` prefix.
3. See `docs/plan/adhd-environment/interfaces-architect.md` §2 for exact type definitions.
