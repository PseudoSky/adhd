# runtime-cli

**Phase:** runtime · **Kind:** work · **Depends on:** builder-snapshot-api, runtime-core-node · **Guard:** `npx nx build environment-cli`

---

## Goal

The `@adhd/environment-cli` package at `entrypoint/environment-cli/` provides an apigen-generated CLI with exactly **9 commands**: `init`, `build`, `set`, `status`, `verify`, `doctor`, `config-get`, `export`, `diff` (the authoritative surface is interfaces-architect.md §6.1). The `adhd-env set` command replaces the `.env` file workflow — stores config values for the builder to resolve.

---

## Acceptance criteria

- [runtime-cli.9] CLI package builds
- [runtime-cli.3] adhd-env set command implemented in commands/set.ts
- [runtime-cli.4] All 9 apigen command functions are exported from api.ts (`init`, `build`, `set`, `status`, `verify`, `doctor`, `configGet`, `exportSnapshot`, `diff`)
- [runtime-cli.5] CLI smoke/integration tests pass (must exercise the full `init → set → build → status → verify → config-get → export → diff` pipeline)

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/environment-cli/src/api.ts", "entrypoint/environment-cli/src/commands/set.ts", "entrypoint/environment-cli/src/core.ts"]
```

---

## Notes for executor

1. The CLI wraps the builder engine (`build()` from `environment-builder`) — it does NOT re-implement build logic.
2. `api.ts` is the apigen extraction surface — export named functions with scalar params.
3. `commands/set.ts` implements the `adhd-env set` command: stores values in an internal store file (e.g., `.adhd-store.json` per namespace) that the builder reads during `build()`.
4. No `.env` file is created or read by any command.
5. Add `generate-cli` target to `project.json` after scaffold (see `scaffold-workspace.md` for exact config).
6. **Command surface (B6/S9):** the CLI is exactly 9 commands. `config-remap` and `config-hash` are **deprecated / out of scope** for v0.0.5 — do not implement them. Export all 9 functions named above from `api.ts`; every command beyond `set`/`build` (`status`, `verify`, `doctor`, `config-get`, `export`, `diff`, `init`) must be covered by the smoke test.
7. See `interfaces-architect.md` §6 for exact API function signatures.