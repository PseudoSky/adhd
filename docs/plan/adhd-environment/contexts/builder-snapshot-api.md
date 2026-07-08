# builder-snapshot-api

**Phase:** builder · **Kind:** work · **Depends on:** builder-engine · **Guard:** `true`

---

## Goal

The `EnvironmentSnapshot<T>` class is fully implemented with typed `.set()`, `.get()`, `.configPath`, and `.write()` methods. The `build()` factory function accepts both `ParsedYamlSpec` and existing `EnvironmentSnapshot` (for rebuilds). Atomic snapshot writing ensures no partial writes on disk.

---

## Acceptance criteria

- [builder-snapshot-api.1] `build(spec)` returns `EnvironmentSnapshot<T>` instance
- [builder-snapshot-api.2] `snap.get("server.port")` returns the resolved value
- [builder-snapshot-api.3] `snap.set("server.port", "4000")` mutates in-memory value
- [builder-snapshot-api.4] `snap.write()` validates via fieldSchema and atomically writes to `snap.configPath`
- [builder-snapshot-api.5] `snap.configPath` resolves to `~/.<org>/<project>/<namespace>/adhd-environment.json`
- [builder-snapshot-api.6] `build(existingSnapshot)` rebuilds preserving values from `.set()`
- [builder-snapshot-api.7] `snap.set("server.port", "50")` followed by `snap.write()` throws validation error (below minimum)
- [builder-snapshot-api.8] Atomic write: kill mid-write leaves no partial `.json` (only `.tmp`)
- [builder-snapshot-api.9] `npx nx build environment-builder` exits 0 (after update)

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