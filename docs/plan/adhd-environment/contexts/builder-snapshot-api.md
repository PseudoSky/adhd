# builder-snapshot-api

**Phase:** builder · **Kind:** work · **Depends on:** builder-engine · **Guard:** `true`

---

## Goal

The `EnvironmentSnapshot<T>` class is fully implemented with typed `.set()`, `.get()`, `.configPath`, and `.write()` methods. The `build()` factory function accepts both `ParsedYamlSpec` and existing `EnvironmentSnapshot` (for rebuilds). Atomic snapshot writing ensures no partial writes on disk.

---

## Acceptance criteria

- [builder-snapshot-api.9] npx nx build environment-builder exits 0 after EnvironmentSnapshot class added
---
## Reservations
```text
read_only:  []
mutates:    ["packages/environment/environment-builder/src/environment-snapshot.ts", "packages/environment/environment-builder/src/index.ts", "packages/environment/environment-builder/src/__tests__/environment-snapshot.test.ts"]
```

---

## Notes for executor

1. `build(spec)` calls `buildSnapshot(spec)` from `builder-engine` internally.
2. `build(existingSnapshot)` reads the snapshot from disk, applies YAML changes, but keeps values set via `snap.set()`.
3. `.write()` must validate BEFORE writing — reject invalid config, never write partial.
4. Use atomic write pattern: write to `<path>.tmp`, then `fs.renameSync()`.
5. The class is typed: `EnvironmentSnapshot<{ data: { db: { path: string } } }>` — use generics.
6. See `interfaces-architect.md` §2 for the typed interface definitions.