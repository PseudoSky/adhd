# cli-adapter — cli-output migration over OpPlan.cliFlags

**Phase:** phase-2 · **Kind:** work · **Depends on:** audit-foundation · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-cli-output:test`

---

## Goal

`cli-output` is a `TransportAdapter`; `readCall` is pure argv-walking over `OpPlan.cliFlags`; `writeResult` is stdout + exit-code; the inline `project()` call is gone; a `streaming:true` op is explicitly rejected; the `--use` capability decision is recorded; the cli [def:parity-gate] is green via a spawned child (incl. flag-edge + help path) with a recorded [inv:negative-control].

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [cli-adapter.1] cli readCall walks OpPlan.cliFlags (no re-derivation)

- [cli-adapter.2] inline project() call removed from cli run.ts
- [cli-adapter.3] committed cli golden snapshot exists
- [cli-adapter.4] cli parity gate green via real spawned child process (argv in, stdout+exit out)
- [cli-adapter.5] negative control: cli regression turns parity RED, restore GREEN
- [cli-adapter.6] cli --use capability decision resolved+documented in code/comment (dod.11); if incapable, a follow-up is filed
- [cli-adapter.7] cli parity fixture includes an env-var-fallback envelope case (F2)
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-core-client/src/lib/plugin.ts"]
mutates:    ["packages/apigen/apigen-plugin-cli-output/src/lib/run.ts", "packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts", "packages/apigen/apigen-plugin-cli-output/src/lib/schema-introspect.ts", "packages/apigen/apigen-plugin-cli-output/src/test/run-cli-integration.spec.ts", "packages/apigen/apigen-plugin-cli-output/src/test/golden/cli.snapshot.json", "docs/plan/apigen-serve-core/neg-control/cli-adapter.patch"]
```

---

## Semantic Distillation

CLI's read side is an argv FLAG TABLE (`run.ts:195-315`: kebab names, `--no-` negation, JSON-typed flags, env-var fallback), materially different from HTTP query/body and MCP `args.data`/`_meta` — so it consumes `OpPlan.cliFlags` (computed once in `serve-core-primitives`), reducing the adapter to argv-walking. `cli-output` has NO `--use` support today; DECIDE during this state whether to add it (consistent with the other transports) or declare CLI `--use`-incapable and FILE that as a follow-up in BACKLOG — do not leave it unstated. Applies [fix:streaming-wired] (reject).

---

## Contract Promise

**modified:** `run.ts` (adapter), `generate.ts`, `schema-introspect.ts`. **deleted:** the inline `project()` call from `run.ts`. **added:** `golden/cli.snapshot.json` + `neg-control/cli-adapter.patch`. Hosts the `[dod.9]` fixture proving `BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001` behavior is UNCHANGED ([inv:out-of-scope-bugs]).

---

## Commit points

(1) capture + commit `golden/cli.snapshot.json` first; (2) migration + parity green; (3) neg-control recorded. Post-guard: `feat(apigen-plugin-cli-output): migrate to TransportAdapter over OpPlan.cliFlags`.

---

## Notes for executor

readCall=parseArgs over OpPlan.cliFlags; writeResult=stdout+exit-code. Real spawned child process only. Decide --use capability explicitly.


## Review folds

- **[fix:use-capability-explicit] (dod.11):** RESOLVE cli-output's `--use` capability (it has zero today) — either add `--use` layer/mount support consistent with the other transports, OR explicitly declare cli-output `--use`-incapable AND file that as a follow-up BACKLOG item. Document the decision in code/comment; do not leave it an unstated gap.
- **F2:** the parity fixture MUST include an env-var-fallback envelope case (`APIGEN_<PLUGINID>_<FIELD>`), exercising `OpPlan.cliFlags[...].envVar` -> `parseArgs` fallback (`run.ts:300-306`).
- Stamp `plan.transport = 'cli'` per [fix:transport-stamping].
