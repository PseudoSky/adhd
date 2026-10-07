# @adhd/nx-test

`test-wiring` — fails if a spec-bearing project has no `test` target, then
delegates to the lane-reachability check below.

`lane-reachability` (`executors/wiring/check-lane-reachability.mjs`) — the
machine check that keeps the push/CI gate's resource-heavy lane reachable and
cached. It is the canonical entry point invoked UNCONDITIONALLY by
`.githooks/pre-push` and both CI workflows (before the lanes), and registered as
`@adhd/source:lane-reachability` / `pnpm run check:lane-reachability`.

It fails when:

1. a project ships `src/**/*.e2e.ts` but declares no `e2e` target (dead config);
2. any `test.dependsOn` contains `e2e` (re-coupling the heavy lane into every
   `nx affected -t test`);
3. any `e2e` target is not `cache: true` with non-empty `inputs` containing
   `default` (the gate must reach it without an uncached re-run);
4. a publishable project's declared `e2e` disagrees with `publish` reaching
   `e2e` — i.e. the conditional in `tools/nx-plugins/build/plugin.js`
   (`hasE2e ? ["e2e"] : []`) is broken (verified by invoking the plugin's OWN
   `createNodes`, never a re-implementation);
5. either CI workflow (`.github/workflows/pull-request.yml`, `ci.yml`) fails to
   invoke every target in `GATE_TARGETS` (`tools/gate/lane-gate.mjs`); or
   `.githooks/pre-push` stops deriving its flags from `.githooks/lib/pre-push-flags.mjs`
   (GATE_TARGETS minus `e2e`), drops `test`, or runs `e2e`;
6. any project with a `tsconfig.spec.json` has no compiling target over it
   (ratcheted via `executors/wiring/lane-reachability.baseline.json`, which may
   only shrink).

Exit code is the only signal (0 = wired, 1 = gap). See the file header for the
full rationale and `check-lane-reachability.spec.mjs` for the per-rule negative
controls.
