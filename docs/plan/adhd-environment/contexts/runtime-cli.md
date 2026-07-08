# runtime-cli

**Phase:** runtime · **Kind:** work · **Depends on:** builder-snapshot-api, runtime-core-node · **Guard:** `true`

---

## Goal

The `@adhd/environment-cli` package at `entrypoint/environment-cli/` provides an apigen-generated CLI with 10 commands including `init`, `build`, `set`, `status`, `verify`, `doctor`, `config-get`, `export`, `diff`. The `adhd-env set` command replaces the `.env` file workflow — stores config values for the builder to resolve.

---

## Acceptance criteria




```text
read_only:  []
mutates:    ["entrypoint/environment-cli/src/api.ts", "entrypoint/environment-cli/src/commands/set.ts", "entrypoint/environment-cli/src/core.ts"]
```

- [runtime-cli.9] CLI package builds
- [runtime-cli.3] adhd-env set command implemented in commands/set.ts
---

## Notes for executor

1. The CLI wraps the builder engine (`build()` from `environment-builder`) — it does NOT re-implement build logic.
2. `api.ts` is the apigen extraction surface — export named functions with scalar params.
3. `commands/set.ts` implements the `adhd-env set` command: stores values in an internal store file (e.g., `.adhd-store.json` per namespace) that the builder reads during `build()`.
4. No `.env` file is created or read by any command.
5. Add `generate-cli` target to `project.json` after scaffold (see `scaffold-workspace.md` for exact config).
6. See `interfaces-architect.md` §6 for exact API function signatures.