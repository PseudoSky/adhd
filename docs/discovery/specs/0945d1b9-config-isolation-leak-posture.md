# Spec 0945d1b9 — spawned children must not resolve the real machine config (HOME-redirect vs resolver gate)

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: 0945d1b9-3b31-488e-9817-fd72aec5637a (bug, HIGH, project adhd)
dor: needs-decision — check: the item records two options and states "D3 decision stands: keep HOME-redirect-only OR scope-gate the resolver"; the owner must confirm one. A recommended option and its fully specified work are below. Size: XS (recommended), M (resolver gate).

## Observed facts (O = opened)
- O: the cascade still applies the global layer unconditionally: `/Users/nix/dev/node/adhd/packages/environment/environment-builder/src/config-resolver.ts:128-133` (`FILE_LAYER_ORDER` includes `['global','global']`), loop `:163-170` applies every non-undefined layer; `layer-files.ts:~83` `global: readLayerFile(join(roots.global, CONFIG_FILENAME))`. `scope` only selects `fieldScope`/provenance. Matches the item.
- O: gx `resolveConfig` upstream = HIGH (d1 `buildSnapshot`; flows `runDoctorChecks`, `verifySnapshot`, `Environment` constructor in `environment-core-node`) — consistent with the item's "5 impacted / 4 modules / 3 processes".
- O: the test-side fix is merged and mechanically guarded IN THE DEFAULT LANE: `entrypoint/backlog/tools/gate/spawn-isolation-gate.mjs` (static scan: any `spawn(process.execPath,[DIST_INDEX…` without importing `spawn-isolated-bin` / `spawn-backlog-bin` fails; header says it runs through the `vocabulary-gate` Nx target, `entrypoint/backlog/project.json:70-86`, which `test.dependsOn` pulls into `nx affected -t test`). Helpers: `entrypoint/backlog/src/test/helpers/spawn-backlog-bin.ts`, `spawn-isolated-bin.ts`.
- O: the sibling item af6d29d5 ("spawn-isolation guard lost its only default-running executor") now reads status `invalid`, i.e. the premise that the guard has no default executor no longer holds for backlog.
- O: the guard only recognises the backlog `DIST_INDEX` spawn shape in `entrypoint/backlog`. Other packages that spawn a bin which resolves the environment cascade (agent-mcp e2e, dispatch-cli, apigen-cli e2e) are governed by adhd ADR-0009 D3 ("isolated cwd and a fake HOME") but with no static guard (R: not inspected beyond ADR text).
- ADRs: adhd 0002 (correct at source; the resolver is the source of the unconditional read), sox 0013 / AGENTS rule (no env-var feature switches) — a resolver gate keyed on an env var is banned; a gate keyed on a typed builder option cannot protect a child process, because the child builds its own environment from argv/env/HOME. Backlog's production store is additionally protected by its production write gate (`entrypoint/backlog/src/production-write-gate.e2e.ts`, `write/production-gate.verbs.spec.ts`).

## Design decisions
D1 (recommended, DECISION for owner): keep HOME-redirect as THE isolation mechanism (D3 stands) and close the remaining hole at the guard, not the resolver. Reason: the leak is a *process-boundary* problem (a child inherits the real HOME); the only inputs a child reads are argv/env/HOME; the sole non-banned in-band signal is HOME itself. A resolver scope-gate either needs an env var (banned) or a typed option the child never receives (no protection), and it changes `resolveConfig` for the doctor/verify/snapshot flows (HIGH).
D2 Extend the static guard repo-wide: lift the scan out of `entrypoint/backlog` into a shared check so any spec/e2e that spawns a bin in a package using `@adhd/environment-*` must import a spawn-isolation helper (or set `HOME` explicitly). Reuse: place the shared helper beside the existing wiring checks `tools/nx-plugins/test/executors/wiring/` (ADR-0009 D4 precedent `check-agent-lane-spawn.mjs`) rather than a new package.
D3 Characterization test in environment-builder documenting the behavior so nobody "fixes" it by accident: global layer IS applied when present; resolution of an absent global file is silent. Test header cites this item (testing standard G12).
D4 Alternative B (rejected as default, kept for the owner): scope-gate via a new typed `EnvironmentOptions.layers?: Array<'system'|'global'|'project'|'local'>` (default all) so in-process embedders (tests that construct an Environment directly) can opt out of the global layer. Protects in-process callers only; additive, backward compatible; costs a HIGH-impact edit. Choose B only if in-process leaks (not spawned children) are the owner's concern.

## Write-scope (exact) — option D1/D2/D3
- /Users/nix/dev/node/adhd/tools/nx-plugins/test/executors/wiring/ new `check-spawn-isolation.mjs` (+ `.spec.mjs`) and its registration beside `check-lane-reachability.mjs` rule list
- /Users/nix/dev/node/adhd/entrypoint/backlog/tools/gate/spawn-isolation-gate.mjs (becomes a thin caller or is superseded; keep the backlog `vocabulary-gate` wiring working)
- /Users/nix/dev/node/adhd/packages/environment/environment-builder/src/__tests__/ (or `src/test/`, follow existing) new `global-layer-applied.spec.ts`
- /Users/nix/dev/node/adhd/packages/environment/environment-builder/README.md (document the posture)
- Option D4 adds: `config-resolver.ts`, `layer-files.ts`, `environment-core-node/src/environment.ts` option plumbing.

## Acceptance criteria
- AC1 A spec/e2e in any package that spawns a bin without a spawn-isolation helper or an explicit `HOME` override fails the shared check (non-zero exit, names file:line).
- AC2 The shared check passes on the current tree (all existing spawn sites routed through helpers) and still covers `entrypoint/backlog` (the old gate's cases are a subset).
- AC3 environment-builder has a test proving the global layer value is applied to `resolveConfig` and that provenance reports `global`.
- AC4 environment-builder README states: spawned processes must redirect HOME; the resolver does not gate layers.
- AC5 (only if D4 chosen) `layers:['project','local']` omits global/system values; default behavior byte-identical; every existing environment-builder test unchanged.

## Test plan (tier S default; cite `0945d1b9 AC<n>`)
AC1/AC2: S (`.spec.mjs`, fixture trees, negative control = fixture with a bare `spawn(process.execPath,[DIST_INDEX…` goes red). AC3: S. AC5: S + the existing resolver suite. No P test needed; a real-spawn proof already exists in backlog helpers.

## Risks / serialization
- Touches `tools/nx-plugins/test/executors/wiring/**` (shared by ADR-0009 lane checks) — serialize with any open lane-gate work; no overlap with other specs in this batch.
- Open for owner: confirm D1 (HOME-redirect + repo-wide guard) vs D4 (resolver option); correct the item (guard exists in default lane; af6d29d5 invalid).
