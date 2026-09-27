# entrypoint/backlog — agent notes

Package-local guidance for agents editing `@adhd/backlog`. The repo-wide rules
live in the root `AGENTS.md`; this file records only the build/startup
invariants that are specific to this package and easy to break.

## Build emits the baked IR artifact

`nx build backlog` is an explicit `build` override in `project.json` that runs
TWO commands, in order:

1. `vite build` — emits `dist/index.js`, `dist/api.d.ts`, …
2. `node dist/index.js ir-artifact --out dist/api.ir.json` — the hidden
   `ir-artifact` subcommand extracts `api.d.ts` and writes the baked operation
   descriptors beside it.

ONE target owns BOTH outputs on purpose: a sibling target declaring the same
`{projectRoot}/dist` output could clobber this one's cache snapshot.

## Startup reads the artifact, then falls back

`server.ts`'s `extractApiOperations()` is a three-step read: `api.d.ts` must
exist → `readBakedIrArtifact(distDir)` (a content-hash-validated hit) → on a
miss, a DYNAMIC `import('./extract-live.js')`.

- `src/ir-artifact.ts` MUST stay ts-morph-free. It is imported statically on
  the startup path; one transitive extractor import would reintroduce the
  multi-second cold start.
- `src/extract-live.ts` is the ONLY module importing extractor-touching code.
  It is reached solely through a dynamic import — never add a static import of
  it from `server.ts` or `cli.ts`.
- The artifact is validated against hashes of the CURRENT built declarations —
  never the bake-time absolute paths (a shipped artifact lands on machines where
  those paths do not exist). The gate covers the WHOLE `dist/**.d.ts` surface,
  not only `api.d.ts`: extraction resolves types THROUGH `api.d.ts`'s sibling
  imports, so a drifted imported `.d.ts` must invalidate the artifact too.

## `ir-artifact` is store-free

The hidden subcommand must never open the store and must never write under
`~/.adhd`. `src/index.ts` deliberately skips `initTelemetry` for it, because
telemetry's default file sink lives under `~/.adhd`.

## `APIGEN_IR_CACHE_ENABLED` scope

`APIGEN_IR_CACHE_ENABLED=0` disables ONLY the runtime FALLBACK cache. It does
NOT bypass the baked `dist/api.ir.json` artifact: that artifact is the
correctness/startup path, produced by the same build as the `.d.ts` it
describes, and has no opt-out.

## `inlineDynamicImports` is load-bearing

`vite.config.ts` forces `build.rollupOptions.output.inlineDynamicImports`. The
dynamic `import('./extract-live.js')` otherwise makes rollup code-split the
entry into a facade plus a shared chunk, which moves the bin entry-guard's
`import.meta.url` into the chunk — and the guard then never matches the invoked
`dist/index.js`, so `node dist/index.js …` silently does nothing. Removing that
setting re-breaks the built binary.

## The shared `dist/` is lock-serialised

`entrypoint/backlog/dist/` is ONE shared, in-tree build output. `build` writes
it — a real `vite build` (`emptyOutDir: true`) wipes the whole dir, and nx's
restore of the bare `{projectRoot}/dist` output is a destructive
`remove(dist); copy(cached, dist)` swap that ALWAYS runs here because `nx.json`
disables the daemon (`useDaemonProcess: false`), so a pure cache HIT still
transiently unlinks `dist/index.js` / `api.ir.json` / `api.d.ts`. Meanwhile the
`e2e` lane spawns `dist/index.js` (and renames `api.ir.json`), and the default
`test` lane reads `dist/api.ir.json` / `dist/api.d.ts`. Under this repo's
concurrent `nx affected -t test` invocations, a build swapping `dist/` mid-suite
kills the reader with `ENOENT dist/index.js` / `built artifact missing`.

Invariant: `build`, `e2e`, and `test` all run through
`tools/with-dist-lock.mjs`, which takes the workspace-wide `backlog-dist` file
lock (`.adhd/tmp/backlog-dist.lock`). `build` is `cache: false` so its
cache-restore can never bypass the lock. Do NOT remove a wrapper, re-enable
`build.cache`, or add a task that reads/writes `dist/` without taking the lock.
(`assets` / `chmod-bin` / `vocabulary-gate` touch `dist/` but are deliberately
NOT locked — locking a fast sibling behind the ~5-min `e2e` lane would blow up
the critical path; their residual exposure is tracked in the backlog.)
