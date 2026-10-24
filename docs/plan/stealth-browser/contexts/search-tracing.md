# search-tracing — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** search-scaffold · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-tracing`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The apigen tracing plugin is configured once with namespace `adhd` and the single `initTelemetry` composition root exists, ready for the hosts to mount; no tests (the logs are validated by the `tracing-log-validation` agent).

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/tracing.ts` and `entrypoint/stealth-search/src/telemetry.ts`.

- **Reference Pattern:** `entrypoint/backlog/src/tracing.ts` (the one `makeTracingPlugin({ serviceName })` site); `entrypoint/backlog/src/index.ts:294` and `serve.ts:289` (`initTelemetry` before the first dispatch, non-fatal warn on failure); `packages/apigen/apigen-plugin-tracing/README.md` (record table); `SPEC-stealth-search.md` section 2.3 telemetry and tracing paragraphs.

- **Delta Spec:** (1) `src/tracing.ts`: `export const tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' })`; the only `serviceName` literal in the package; never import the plugin package's own singleton (namespace `apigen`). (2) `src/telemetry.ts`: one exported function (for example `initSearchTelemetry({ role, logDir })`) calling `initTelemetry({ service: 'stealth-search', role, logSink: 'file', ...(logDir ? { logDir } : {}) })` inside try/catch that warns once on stderr and continues. The telemetry SERVICE `stealth-search` and the apigen namespace `adhd` are distinct on purpose. Without `initTelemetry` the plugin writes to a no-op sink. (3) Both files are consumed by `search-hosts`, which mounts the plugin in every `usePlugins` array and calls the telemetry function once per bin before the first dispatch. Record `initTelemetry` and `makeTracingPlugin` exact import paths after reading the backlog entrypoint (resolve at dispatch).

- **Invariants:** [inv:trace-namespace] [def:telemetry] [inv:typed-errors]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-tracing]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-tracing` — runs every acceptance criterion below (red until the work is done); `--only search-tracing.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-tracing --only search-tracing.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-tracing.1] src/tracing.ts exports `tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' })` and is the ONLY file under entrypoint/stealth-search/src and bin that contains a `serviceName` literal; the literal is `adhd`.
- [search-tracing.2] The package's own `tracingPlugin` singleton (namespace `apigen`) is never imported: no file in src or bin imports `tracingPlugin` from `@adhd/apigen-plugin-tracing`, and no `apigen` serviceName appears.
- [search-tracing.3] src/telemetry.ts is the single telemetry composition root: it exports one function that calls `initTelemetry({ service: 'stealth-search', role, logSink: 'file', ... })` with `role` of `cli` or `live-service` and an optional `logDir`, failure is non-fatal and warned once on stderr, and exactly ONE `initTelemetry(` call exists in all non-test source under src and bin (in telemetry.ts).
- [search-tracing.4] Neither file reads the environment (no `process.env`, ADR-0001), neither constructs a bare Error, and `nx run stealth-search:typecheck` and `:lint` exit 0.
- [search-tracing.5] Only owned paths changed by [psm:search-tracing] commits.

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/tracing.ts", "entrypoint/stealth-search/src/telemetry.ts"]
```

---

## Contract Promise

Added: `src/tracing.ts`, `src/telemetry.ts`. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-tracing]`:

- [ ] After the guard passes: `feat(stealth-search): tracing plugin and telemetry composition root [psm:search-tracing]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.
