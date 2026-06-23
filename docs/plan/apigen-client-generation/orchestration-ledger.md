# Orchestration Ledger — apigen-client-generation

- **Plan dir:** `/Users/nix/dev/node/adhd/docs/plan/apigen-client-generation`
- **$SKILL (installed cache):** `~/.claude/plugins/cache/sox-subagents/workflow/0.8.15/skills/plan-state-machine/scripts`
- **Orchestrator run:** 2026-06-21
- **Outcome of run:** ⛔ **HALTED at preflight — no states dispatched.** Plan does not pass its own gate scripts.

<!-- wave-9 progress: plugin-jsonschema ✅ complete (commit 85f0f8f, guard rc=0 7 tests, sonnet/low, typescript-pro); plugin-cli-output ⏳; plugin-mcp + plugin-api-express serialized next. plugin-fastify-checkpoint ✅ (GATE-A cleared, F20). -->

## ⚠ CALLER-ADDED GATES (mandatory halts — honor on resume)
- **GATE-A:** `plugin-fastify-checkpoint` (wave 8) — **CLEARED 2026-06-21** via caller RESUME directive (after reference-plugin review). Approval artifact committed; checkpoint complete; advanced→plugin-jsonschema. See F20 for the exit-4 quirk hit here.
- **GATE-B (caller-added 2026-06-21):** **HALT for human approval immediately after `cli-run-cmd` completes (the non-codegen live-server CLI), before dispatching `audit-cli`.** When `cli-run-cmd` reaches `complete` (current_state→audit-cli), DO NOT dispatch audit-cli. Instead: present the live-server `run` CLI to the caller with a command they can try themselves (`npx tsx packages/apigen/cli/src/index.ts run --source <ts> --type mcp|api-fastify`), await explicit approval, then write `checkpoints/cli-run-approved.md`, **`git add`+commit it BEFORE `--complete`** (see F20), and continue. Mechanism = orchestrator-enforced (no dag node added — F19). Approval artifact mirrors the fastify checkpoint convention.

## Dispatch rows

| slug | wave | executor | tier | est-tokens | guard-exit | retries | outcome | notes |
|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | none | Preflight red; zero dispatches issued (pre-amendment). |
| scaffold-packages | 0 | typescript-pro | sonnet/low | ~4.8KB (ratio 0.9813) | guard rc=0 (4/4); my independent re-run rc=0 | 0 | **advance** | 4 pkgs (core/runtime/nx/cli) created; commit 693fe3b. Verified state-side: status=complete, current_state→core-types. transition_log `audit_exit:2,criteria 0/0` is the work-state recording quirk (not a fail — guard genuinely rc=0). |
| core-types | 1 | typescript-pro | sonnet/medium | ~4.5KB (ratio 0.9826) | guard `nx build apigen-core` rc=0; my re-run rc=0 | 0 | **advance** | types.ts (GeneratedSchemas/ComposedSchemas/ExportMode/OutputPlugin/…) + index.ts; commit c88cfcd. transition_log `audit_exit:1` (work-state quirk again — value varies, guard genuinely rc=0). |
| nx-generator | 2 (serial 1/3) | typescript-pro | sonnet/medium | ~13.8KB (ratio 0.9467) | guard `nx build apigen-nx` rc=0; my re-run rc=0 ("2/2 tasks" = pulls apigen-core dep) | 0 | **advance** | pluginGenerator + 4 EJS templates + generateExecutor; commit 8ab11fa. Confirms apigen-nx→apigen-core dep ⇒ serialization (F11) was correct. |
| schema-extraction | 2 (serial 2/3) | typescript-pro | sonnet/medium | ~10.5KB (ratio 0.9594) | guard `nx test apigen-core …generate-schemas` rc=0; my re-run rc=0 | 0 | **advance** | generateSchemas + 3 extractors + 2 schema-builders; deps ts-morph@^23, ts-json-schema-generator@^2.3; commit 1719847. ⚠ breached reservation: edited `core/project.json` (added @nx/vite:test target so `--testFile` resolves) — benign (no later state owns it; unblocks next guard). See F13. |
| schema-composition | 2 (serial 3/3) | typescript-pro | sonnet/medium | ~5.6KB (ratio 0.9784) | guard `nx test apigen-core …compose-schemas` rc=0; my re-run rc=0 | 0 | **advance** | composeSchemas (envelope merge, always-on data wrapper, false-override suppression); commit 1c8fc5a. F12 fix VERIFIED: index.ts re-exports real composeSchemas, throwing stub gone. |
| audit-core | 3 (audit gate) | orchestrator-driven | opus/hard→see F15 | foundation audit | first run rc=1 (F14 guard bug); after fix **rc=0, 19/19**; `--complete` rc=0 `audit_pass:true` | 0 | **advance** | F14 guard fix applied (caller-approved): all 21 `--testPathPattern`→vitest positional; committed. Product was already good (nx test apigen-nx 13/13). Drove gate bookkeeping myself (deterministic, pre-verified) rather than spend an opus agent — see F15. `audit_criteria 0/0` recording quirk; `audit_pass:true` is the real signal. next→runtime-middleware. |
| runtime-middleware | 4 (serial 1/2) | typescript-pro | sonnet/medium | ~ratio≈0.96 | guard `nx test apigen-runtime …api-package` rc=0 (8 tests); my re-run rc=0 | 0 | **advance** | MiddlewareDef/EventBus/buildContext/createApiPackage + index exports; commit 143d54e. Applied F13 fix (added @nx/vite:test target to apigen-runtime, authorized). |
| runtime-dispatch | 4 (serial 2/2) | typescript-pro | sonnet/medium | ~ratio≈0.97 | guard `nx test apigen-runtime …dispatch` rc=0 (8 tests); my re-run rc=0 | 0 | **advance** | dispatch + needsEnvelopeField/dataParamNames; commit db53d61. F12-like fix: dispatch now exported from runtime/index.ts (authorized). |
| audit-runtime | 5 (audit gate) | orchestrator-driven | opus/hard→F15 | runtime audit | my run **rc=0, 13/13**; `--complete` rc=0 `audit_pass:true` | 0 | **advance** | No guard bug this phase. Drove gate directly (pre-verified). next→scaffold-plugins. |
| scaffold-plugins | 6 | typescript-pro | sonnet/low | ~7.0KB (ratio 0.9731) | guard rc=0 (5/5); my re-run rc=0 | 0 | **advance** | 5 plugins generated via `nx g @adhd/apigen-nx:plugin`; commit 23433af. All 5 have @nx/vite:test (F13 pre-empted). ⚠ executor had to add vite.config/tsconfig/test target — generator template gap (F16). |
| plugin-api-fastify | 7 | backend-developer | sonnet/medium | ~4.6KB (ratio 0.9824) | guard `nx test apigen-plugin-api-fastify` rc=0 (9 tests); my re-run rc=0 | 0 | **advance** | OutputPlugin generate()/run() emits `POST /<id>/<fn>` routes, imports dispatch, NO body json-schema (AJV pitfall avoided); commit a6bf776. Real-Fastify test returns correct value. |
| F16 generator fix | out-of-band | fix-generator-f16 + orchestrator | — | my dod.8-style proof | generate/build/test rc=0 (positional + --name) | 0 | **done** | F16: added 4 EJS templates (vite.config+3 tsconfig); commit d970a5e. Caught 2nd bug myself: schema.json lacked positional `name` `$default` → dod.8's `nx g …:plugin test-plugin` failed "Required property name missing". Fixed directly (caller-directed); commit (schema). VERIFIED: positional `nx g …:plugin test-plugin && nx build` rc=0, emits vite.config+tsconfig. Probes cleaned; tsconfig.base.json reverted. dod.8 unblocked. |

## Preflight results

| check | exit | verdict |
|---|---|---|
| `compile-task.js --board` | 0 | OK — 23 tasks, 16 waves, crit-path cost 16. Write-conflict @ wave 9 (`plugin-api-express` + `plugin-mcp` both write `package.json`) → worktree-isolate/serialize when reached. |
| `skill-version-check.js` | — | **UNSTAMPED** — no `authored_with`; schema_version 2 (current cache workflow@0.8.15+a71a190f4d67). Plan authored under older skill schema, never migrated. |
| `env-pin-check.js --strict` | **4** | **FAIL** — 4/23 guards not env-pinned: `scaffold-packages`, `scaffold-plugins`, `plugin-fastify-checkpoint`, `done`. Strict mode = mandatory halt (bare-PATH tools non-deterministic in executor subprocess). |
| `gap-check.js` | **44** | **FAIL** — DoD provenance, proxy DoD checks, invalid interface manifest, unmapped states (detail below). |
| `cross-plan-check.js` | 2 | needs `plan-index.js` run first (no `plan-index.json`). Minor/setup, not a real cross-plan conflict. |
| board tiers | — | **All 23 states `unrated`** — dag.json carries no `model`/`effort` annotations (0 hits). Orchestrator cannot honor declared tiers; routing tier would be a guess. |

## Findings (for planner amendment)

### F1 — env-pin strict fail (class: planner, type: fix-guard) [HALT]
`scaffold-packages` and `scaffold-plugins` carry no pinned tool-resolution marker — their guards likely call bare `nx`/`tsc` resolved off ambient `PATH`, which differs in the executor's clean subprocess. `plugin-fastify-checkpoint` (human-approval gate) and `done` (terminal) are gate states but still fail strict. Fix: pin each guard's toolchain (`npx --yes nx …`, repo-local `tsc`) or mark gate states as guard-less per the skill's marker convention.

### F2 — DoD never confirmed with requester (class: planner / caller) [HALT]
`state.json.dod_provenance` is `null`. The 8 DoD clauses in README were reverse-engineered from the AGENT_PROMPT/spec and never confirmed. Must be confirmed via `state-transition.js --confirm-dod` AFTER the caller approves the clauses. Surfaced to caller for confirmation.

### F3 — DoD clauses are PROXY checks (class: planner, type: fix-dod) [HALT]
Clauses `[dod.1]`, `[dod.2]`, `[dod.5]`, `[dod.7]` drive an entrypoint (`npx tsx … run --type mcp`, `nx run apigen-cli:generate-api`, etc.) but never **assert** the declared observable — the interaction happens, the consumer truth is never verified. This is the exact anti-pattern in the repo's verification standard (CLAUDE.md §6). Each also lacks `negative-control:` (a must-fail perturbation) and `delivered-by:` (which state delivers the outcome). Fix: rewrite each check to assert its observable, add a negative control, add delivered-by.

### F4 — No `## Value delta` in README (class: planner, type: fix-dod) [HALT]
README has no before→after consumer-observable header, so DoD clauses aren't testable slices of a named outcome.

### F5 — 17 work states float free of any outcome (class: planner, type: fix-dod) [HALT]
17 states bear acceptance criteria but no DoD clause names them in `delivered-by:` (scaffold-packages, core-types, schema-extraction, schema-composition, runtime-middleware, runtime-dispatch, scaffold-plugins, plugin-jsonschema, plugin-mcp, plugin-api-fastify, plugin-api-express, plugin-cli-output, cli-generate-cmd, cli-run-cmd, nx-generator, integration-tests). Map every state to a delivering outcome.

### F6 — interfaces.json schema-invalid (class: planner, type: fix-interface) [HALT]
5 interfaces (`mcp-sdk`, `nx-devkit`, `commander`, `fastify`, `express`) fail two rules each: required field `interface` is null/empty (they use a legacy `shape` field) and `confidence: "high"` is not in the allowed enum `verified|vendored|documented|assumed`. (`ts-morph`, `ts-json-schema-generator` share the legacy shape but were not flagged — partial schema drift.) Likely a side-effect of authoring under an older skill schema. Fix: migrate the manifest to the 0.8.15 schema (`interface` field + enum confidence; provenance `vendored-source` → `vendored`).

### F7 — Plan unstamped / unmigrated (class: planner, type: migrate)
`migrate-plan.js --dry-run`: schema_version 2 → 3, stamp `authored_with`. Migration alone does NOT fix F1/F3–F6 (those are content gaps under the new schema), but it should run as the first remediation step so subsequent gate runs validate against the current schema.

### F9 — `decide()` requires `next_state` in the completion payload (orchestrator usage)
`orchestrate-plan.js --decide` keys on `stdout.next_state` (pure fn, `lib/orchestrate-decision.js:81-85`). Omitting it → defaults to `action:done/plan_complete` even mid-plan. Always feed `--decide` the REAL `state-transition --complete` stdout (with `next_state`) + real exit code, and cross-check against `current_state` state-side. Caught a false "done" at wave 0 this way.

### F10 — context-header guard text is stale vs dag.json (cosmetic, class: planner)
`contexts/scaffold-packages.md` header still shows the pre-amendment `node -e` guard while `dag.json` now uses `python3 …​audit_apigen.py --phase scaffold-packages`. Non-blocking (dag.json is authoritative) but should be reconciled in a future cleanup; likely affects the other 3 F1-pinned states' context headers too.

### F11 — board write-conflict detector misses same-project build contention (orchestrator routing)
Board flagged only wave-9 (identical `package.json` writes) but NOT wave 2, where `nx-generator`/`schema-extraction`/`schema-composition` all share the `apigen-core` compile surface (both schema states run `nx test apigen-core`; `nx build apigen-nx` pulls core as a dep). Concurrent nx builds/tests of the same project graph race on `dist/`/cache → nondeterministic guard failures. Orchestrator decision: **serialize wave 2** (nx-generator → schema-extraction → schema-composition). Suggest the board also flag same-nx-project contention, not just identical-file writes.

### F12 — index.ts has no post-core-types owner, but later states must export through it (class: planner, type: fix-reservation) [latent green-but-broken risk]
`core/src/index.ts` is reserved only by `core-types`. It carries an inline `composeSchemas` STUB that throws "not implemented — see schema-composition state", but `schema-composition`'s reservation is only `lib/compose-schemas.ts` + spec — NOT index.ts. If the executor honors the reservation literally, the package's PUBLIC `composeSchemas` stays the throwing stub while the real impl sits unexported in lib → `import { composeSchemas }` from `@adhd/apigen-core` throws at runtime (audit-core may pass on a grep; integration-tests/dod.4 would break). Orchestrator action: explicitly AUTHORIZED schema-composition to reconcile index.ts's composeSchemas export (collision-free — serialized wave, no other owner). Planner amendment: add `index.ts` to the reservation of every state that must export a new public symbol, or designate an explicit "export-wiring" owner.

### F13 — guard infra incomplete: `--testFile` needed a test target the scaffold didn't create (class: planner, type: fix-guard)
schema-extraction had to add an `@nx/vite:test` target to `core/project.json` for the `nx test … --testFile=…` guard to resolve. Either `scaffold-packages` should create that target, or the schema guards should not rely on `--testFile`. Affects every `--testFile`-based guard (schema-composition, runtime-*, plugin-*).

### F14 — audit guard uses Jest `--testPathPattern` under vitest (class: planner, type: fix-guard) [HALT @ audit-core]
`audit_apigen.py` has **21** `--testPathPattern=…` invocations; vitest rejects the flag (`CACError: Unknown option --testPathPattern`), so every such check fails regardless of product correctness. Affected: foundation `nx-generator.1/4/5/6/7` (blocking audit-core now) + all 14 `integration-tests.*` (would block audit-cli wave 12 / audit-final wave 14) + 2 others. **Product is verified good independently** (`nx test apigen-nx` → 13/13 pass). PROPOSED FIX (caller approval required — modifying an audit gate): replace each `--testPathPattern=<path>` with the proven-working `--testFile=<full-spec-path>` (@nx/vite:test alias used successfully by schema-extraction/composition), preserving any `-t '<name>'` filter (vitest supports `-t`). Likely introduced when pass-2 added the integration checks (caller decision #4) using Jest idiom. After fix: re-run foundation audit (expect rc=0), complete audit-core, continue.

### F13 (generalized) — `--testFile` guards require an explicit `@nx/vite:test` target only `apigen-core` has (class: planner, type: fix-guard)
`apigen-core` got an explicit `@nx/vite:test` target (schema-extraction) so `--testFile` resolves. `apigen-nx`/`apigen-runtime`/`apigen-cli`/plugins use nx's INFERRED target, which forwards `--testFile` straight to vitest → `CACError: Unknown option --testFile`. Every state guard using `--testFile` (runtime-middleware, runtime-dispatch, plugins, cli, …) will fail until its package has the explicit target. Fix: either `scaffold-packages`/`scaffold-plugins` add the explicit `@nx/vite:test` target to every package, or convert guards to the vitest positional. Orchestrator interim: authorize each "first-in-package" executor to add the target (mirroring apigen-core).

### F15 — audit states annotated opus/hard but are deterministic scripts (class: planner, type: tiering)
audit-core/runtime/plugins/cli/final run `audit_apigen.py --phase X` — a deterministic pass/fail script, no judgment. opus/hard (F8 heuristic) is over-tier; an opus agent to re-run a passing script is a cost defect. Orchestrator drives these gate completions directly AFTER independent verification (run the audit, confirm rc=0, then --complete). Re-tier audits to the cheapest tier or mark them orchestrator-driven gates.

### F16 — audited nx generator emits non-buildable plugin packages (class: planner, type: fix-generator) [CALLER-DIRECTED FIX 2026-06-21]
**Precise root cause:** generator `__files__/` emits only 4 files (package.json, src/index.ts, src/lib/plugin.ts, src/test/plugin.spec.ts). `generator.ts addProjectConfiguration` DOES add `@nx/vite:build` + `@nx/vite:test` targets — but those reference a `vite.config.ts` + tsconfig.{json,lib,spec} that the templates NEVER emit ⇒ fresh `nx g` plugin can't build/test. scaffold-plugins patched each of the 5 instances; `dod.8` (audit-final) generates a FRESH plugin and builds it → would FAIL until the template is fixed.
**Fix (caller-directed):** add 4 EJS templates to `__files__` — `vite.config.ts__tmpl__`, `tsconfig.json__tmpl__`, `tsconfig.lib.json__tmpl__`, `tsconfig.spec.json__tmpl__` — mirroring the proven-working `packages/apigen/plugins/api-fastify/*` configs (correct for the deeper `plugins/<name>` depth/offsetFromRoot). Prove with a throwaway `nx g … && nx build && nx test` that succeeds with NO manual patching; clean up the probe (delete pkg + revert tsconfig.base.json entry). Then re-run nx-generator audit + record via `state-transition --amend nx-generator`.
**SEQUENCING:** deferred until `plugin-api-fastify` (wave 7) completes — concurrent nx g/build vs its nx test would corrupt the project graph (known hazard). Dispatch immediately on its idle.
**Also flag:** the nx-generator behavior audit should add a "raw generator output builds" check — the gap that let a non-buildable generator pass green.

### F17 — lockfile PM contamination: repo uses yarn, an executor/npx touched package-lock.json (hygiene) [RESOLVED]
Repo tracks THREE lockfiles (yarn.lock, package-lock.json, pnpm-lock.yaml — all pre-existing). Dep additions correctly updated+committed `yarn.lock` (yarn is the active PM). But an `npm install`/`npx` run left an uncommitted ~42k-line `package-lock.json` diff (npm re-resolution noise in a yarn repo). REVERTED `package-lock.json` to its tracked state; yarn.lock retains the real dep updates. Working tree now clean. Future: instruct executors to use `yarn add <pkg>` (not npm) to avoid cross-PM lockfile churn.

### RESERVATION AUDIT (caller-requested 2026-06-21) — CLEAN ✅
Audited `git diff --name-only fb684ce..HEAD`. Every change confined to `packages/apigen/**` + 3 authorized shared files (`tsconfig.base.json` path wiring, `package.json` deps, `yarn.lock`). **NO pre-existing package touched** — agent-mcp, data, query, transform, react-hooks, decompile, storybook, design-system, features, shared ALL untouched. Within-apigen authorized cross-reservation edits (all benign, no collision): schema-extraction→core/project.json (F13 test target), schema-composition→core/src/index.ts (F12 export), runtime-middleware→runtime/project.json (F13), runtime-dispatch→runtime/src/index.ts (F12 export), scaffold-plugins→5 plugin configs (F16 workaround).

### F18 — generator schema missing positional `name` `$default` (class: planner, type: fix-generator) [FIXED]
`schema.json` required `name` but had no `$default:{$source:argv,index:0}` → positional `nx g …:plugin <name>` failed; only `--name=` worked. dod.8's audit command uses positional form → would have failed. Fixed directly (added `$default` + x-prompt); verified positional generate+build rc=0. Committed.

### F19 — formalize GATE-B as a real dag state (class: planner, type: add-checkpoint) [PROPOSED]
Caller wants a human approval after the non-codegen live-server CLI (`cli-run-cmd`). Implemented now as an orchestrator-enforced gate (GATE-B above) because mid-flight there is NO clean script to add a `state.json` entry for a new dag node (`migrate-plan`/`integrity-check` only iterate existing states; hand-editing state.json/dag.json is barred). PROPOSED structural version (apply at next plan re-author / via proper amendment tooling): add node `cli-run-checkpoint` mirroring `plugin-fastify-checkpoint` — `kind:audit`, `depends_on:["cli-run-cmd"]`, guard `python3 …audit_apigen.py --phase cli-run-checkpoint` (checks `checkpoints/cli-run-approved.md`), artifact `checkpoints/cli-run-approved.md`, context `contexts/cli-run-checkpoint.md`; rewire `audit-cli.depends_on` → `["cli-generate-cmd","cli-run-checkpoint"]`; add the audit phase + criterion id. Requires a skill mechanism to insert the state.json entry (none exists today — itself a gap worth raising upstream).

### F20 — 0.8.18 audits run at end_ref ⇒ checkpoint approval artifact MUST be committed before --complete (orchestrator procedure) [RESOLVED for GATE-A]
RESUMED on workflow 0.8.18. `state-transition.js:256 auditPass = (auditExit===0)` and the audit runs **at end_ref** (committed tree, `ran_at_end_ref:true`). At plugin-fastify-checkpoint --complete: my working-tree guard run passed (rc=0) but state-transition's end_ref run FAILED → exit 4, audit_pass:false — because `checkpoints/fastify-approved.md` was created untracked and was ABSENT from end_ref (audit_apigen.py itself was tracked, so only the approval file was missing). The state still advanced (status complete, →plugin-jsonschema) and the human gate is genuinely satisfied (caller approved + working-tree guard rc=0). FIX: committed the approval artifact (now in HEAD, audit passes). LESSON (applies to GATE-B + any checkpoint): create the approval file, `git add`+commit it, THEN run --complete, so the end_ref audit sees it. Not a real audit failure; not fabricated — a genuine human approval persisted properly. (Under 0.8.15 audits ran against the working tree, so this never surfaced.)

### F21 — plugin-cli-output project mis-named by scaffold (class: planner, type: fix-naming) [FIXED]
`scaffold-plugins` generated the cli plugin as project `apigen-plugin-cli` (dir `plugins/cli`), but the slug `plugin-cli-output`, the guard `nx test apigen-plugin-cli-output`, and every sibling plugin's convention (slug suffix == project name) expect `apigen-plugin-cli-output`. Result: guard failed with `NX Cannot find project 'apigen-plugin-cli-output'` (rc=1) and the state stayed in_progress — the plugin's 14 tests genuinely PASS under the real name (`nx test apigen-plugin-cli` rc=0). **Confirms plugins do build/test** (the guard failed loudly on a missing project, not a skipped test). FIX: rename nx project `apigen-plugin-cli`→`apigen-plugin-cli-output` (project.json/package.json/tsconfig path/vite refs), keep dir `plugins/cli`, re-run guard, --complete. Root cause: dag internal inconsistency (writes target `plugins/cli` dir but guard names `apigen-plugin-cli-output`); scaffold derived the name from the dir. Planner: make scaffold use the slug-suffix project name, or fix the guard to match the dir.

### F24 (update) — lint enablement (caller-directed)
Root cause: nx.json uses `@nx/eslint/plugin` → lint is INFERRED for any project with an `.eslintrc.json` (extending root `.eslintrc.base.json`). The 4 core pkgs (scaffolded via `@nx/js:library`) got one; the custom `@adhd/apigen-nx:plugin` generator never emitted one → 5 plugins unlintable.
- **FIXED + committed:** generator `__files__` now emits a root-extending `.eslintrc.json__tmpl__` (depth-4 base path) → generated plugins inherit lint; stub made lint-clean (dropped over-declared `@adhd/apigen-runtime` dep that `@nx/dependency-checks` flagged; marked unused `input`). Verified via probe: fresh plugin lint rc=0 + build rc=0.
- **Backfilled** `.eslintrc.json` into the 5 existing plugins (working tree).
- **Ran `nx lint --fix`** across apigen: auto-resolved dependency-checks (jsonschema dropped unused runtime; runtime gained apigen-core; nx dropped unused apigen-core; api-express deps) + unused imports.
- **Remaining 2 blockers (rc=1), both root-caused:**
  1. `apigen-core` — 2 errors in `src/test/fixtures/*` (`no-empty-function`); fixtures are signature-only by design → fix = eslint override for `**/test/fixtures/**` disabling no-empty-function + no-unused-vars.
  2. `apigen-plugin-mcp` — 1 error: `@nx/enforce-module-boundaries` "static import of lazy-loaded library" — `run.spec.ts:190` does `await import('@adhd/apigen-runtime')` (dynamic) while `run.ts:7` imports it static; nx forbids mixing → fix = make the test import static.
- **Non-blocking warnings** catalogued: mcp (3×`any`, 2×non-null), api-fastify (non-null + `Fastify`/`dispatch` imported but only referenced in template strings → likely dead imports), api-express (non-null), runtime (3), nx (3×non-null).
- **F24b (new finding):** plugin `nx test` guards never typechecked OR linted; lint also surfaced that some plugins import libs only inside emitted template strings (dead top-level imports) — another reason per-state guards must run the full verify suite (ties to the run-full-verify reflection).

### F8 — No tier annotations (class: planner, type: tiering)
Every state is `unrated`. Without `model`/`effort` the orchestrator cannot honor declared tiers and would have to guess routing. Planner should annotate (impl states → sonnet; audit/review/checkpoint gates → opus; scaffold → haiku/sonnet).

## Planner amendment dispatched (2026-06-21)
- Dispatched `workflow-planner` (opus) → produced `check-audit-and-amendment.md` (Part A check audit + Part B amendment spec).
- **Executive verdict (planner):** green CAN coexist with a broken product today — every behavioral DoD clause (dod.1/2/5) delegates to integration spec files that don't exist yet; the audit only trusts the runner exit code, asserting no observable itself. The `test -f … && nx test` pattern is file-existence theater + a vacuous-spec hole.
- **Top coverage holes:** (1) the headline observable `callTool('getUser',{data:{userId:'abc'}})→{id:'abc',name:'Alice',role:'user'}` is asserted NOWHERE (prose only); (2) MCP `sse`/`streaming-http` transports have zero coverage; (3) generated CLI-output code is never executed; (4) dod.7 cache-awareness runs the target once (proves no caching); (5) 7 advertised `integration-tests.*` IDs are never run (ID inflation); (6) no live-model e2e test.
- **Orchestrator gate-verification (corrected planner's F1+F6):** validated proposal vs `gap-check.js:931-942` + `lib/env-pin.js`. Corrections recorded in §0 of the amendment doc:
  - F6: required fields are ALL of `interface,shape,provenance,confidence` → ADD `interface`, KEEP `shape` (don't rename). `provenance:"vendored-source"` is VALID (PROV enum) — do NOT change to `vendored`. `confidence:"high"→"vendored"` correct. All 7 entries affected. No `[iface:]` citations exist → add them.
  - F1: no `# guard-less-gate:` sentinel exists; pin the 4 guards via a `python3 …​.py` audit phase or `npx --yes`.
  - F4: literal `## Value delta` heading confirmed required.

## Caller decisions (2026-06-21) — approved, applying
1. **No hard-coded observables** — tools are generalized; checks must DERIVE expected values from the fixture (call in-process → ground truth → assert MCP/HTTP/CLI result deep-equals it). No baked-in `{id:'abc',…}` literal in any probe.
2. **Execute the CLI** — generated CLI-output plugin code must be run as a subprocess and its stdout asserted; add a behavioral CLI-output DoD clause.
3. **All 3 MCP transports** — stdio, sse, streaming-http all probed.
4. **Add the 7 missing `integration-tests.*` checks** (.2 .4 .6 .7 .9 .11 .13).
5. **Test the real thing everywhere** — real components (real engine/server/CLI), mock only the external boundary; add `APIGEN_LIVE=1`-gated real-model MCP e2e.
6. **Apply all** — proceed: planner applies corrected amendment → orchestrator re-runs all gates → stamp DoD → wave-0 dispatch.

## Amendment apply — pass 1 (apigen-applier, 2026-06-21)
Verified state-side by re-running gates (not the agent's report):
- `env-pin --strict`: rc=4 → **rc=0 (PASS)**. 4 guards routed through python audit phases.
- `gap-check`: rc=44 → **rc=14** (still FAIL). interfaces.json fixed; F4/F5/F8 done; dod.3/4/6/8 now pass. Created `scripts/probe_mcp.mjs` (19KB) + expanded `audit_apigen.py` (39KB).
- 23 WARNs: "Reservations/mutates block not machine-parseable" across all contexts — non-blocking but degrades board write-conflict detection (relevant to wave-9).

### Remaining 14 FAILs → pass-2 punch-list
1. **dod.1/2/5/7 lack `negative-control:`** — applier omitted the must-fail sub-field.
2. **dod.1/2/5 "no proving check drives the declared entrypoint <token>"** — generalizing into `probe_mcp.mjs` removed the literal entrypoint token (fixture path / cli index path) from the audit check command, so the gate can't see the check drives the declared entrypoint. FIX: pass the entrypoint as explicit args to the probe so the token appears literally (preserves generalization — source/cli are params).
3. **[dod.cli] not proven by any final-audit check** — new CLI-output clause added but no matching check ID wired.
4. **dod.7 under-done** — missing `entrypoint:`, `delivered-by:`, `negative-control:`; outcome text uses builder mechanic "project.json"; proven only by grep/test (never executes the nx target twice).

## Amendment apply — pass 2 + orchestrator gate-conformance (2026-06-21)
- Pass 2 (apigen-applier2): closed 11 of 14 FAILs (negative-controls, entrypoint-token visibility via generalized-probe args, [dod.cli] check wiring, dod.7 real two-run cache check). gap-check 14 → 3.
- Orchestrator gate-conformance edits (token insertion only, planner semantics preserved — derived from `gap-check.js:445 distinctiveToken`): dod.2 nc now contains observable token `tools/list`; dod.cli nc now contains entrypoint token `…/real-api.ts`. gap-check 3 → 1.
- DoD provenance stamped via `state-transition.js --confirm-dod` (9 clauses: dod.1–8 + dod.cli). gap-check 1 → **0**.

## ✅ PREFLIGHT GREEN (2026-06-21) — cleared for dispatch
| gate | rc |
|---|---|
| env-pin --strict | 0 |
| gap-check | 0 |
| cross-plan-check | 0 (after plan-index) |
| board | compiles; tiers low:4/medium:13/hard:6; crit-path 35; 16 waves |
- Standing flag: **wave-9 write-conflict** — `plugin-api-express` + `plugin-mcp` both write `package.json` → worktree-isolate or serialize when reached.

## Proposed remediation order (DONE — superseded by green preflight above)
1. Caller confirms the 8 DoD clauses (see report) → enables F2.
2. Planner amendment addressing F1, F3–F6, F8 (the structural authoring gaps).
3. `migrate-plan.js` to stamp + bump schema (F7); `plan-index.js` to clear cross-plan (rc=2).
4. Re-run all preflight gates → must be green before any dispatch.
5. Resume orchestration from wave 0 (`scaffold-packages`).

<!-- cli-generate-cmd ✅ (3644ab5; test/lint/build rc=0, full-verify held). nx-inheritance learning filed 01KVP853DG (global). Next: cli-run-cmd → GATE-B halt. -->

### F25 — DoD entrypoint `npx tsx src/index.ts` fails without `--tsconfig` (class: planner, type: fix-entrypoint) [blocks audit-final dod.1/2/5]
The documented entrypoint `npx tsx packages/apigen/cli/src/index.ts run …` fails at runtime: `Cannot find module '@adhd/apigen-core'` — tsx does not resolve the workspace tsconfig path aliases (cli/tsconfig.json extends base but tsx doesn't merge extends `paths`). WORKING form: `npx tsx --tsconfig tsconfig.base.json packages/apigen/cli/src/index.ts run …` (verified: live MCP server starts + exits 0 on transport close). `run.spec.ts` passed because it imports `registerRunCommand` directly (never the real entrypoint). **Blast radius:** `probe_mcp.mjs` spawns the BARE form (`:189` stdio, `:254` http) → dod.1/2/5/cli will FAIL at audit-final. Fix options: (a) add `--tsconfig tsconfig.base.json` to the probe spawns + README DoD entrypoints, or (b) give apigen-cli a built `bin` run via node. Also: the canonical `real-api.ts` fixture is created in integration-tests (wave 13), so the exact dod.1 command only runs from wave 13 on (expected). cli-run-cmd verified: test/lint/build rc=0 (commit f61ca6f); live server works via the --tsconfig form.

### F26 — package shipped as workspace-dev-bound, not a standalone CLI (class: planner, type: fix-dod + corrective-phase) [caller-directed]
The package's PURPOSE is a standalone `@adhd/apigen-cli` (run from any dir on any file), but the plan delivered a workspace-bound dev entrypoint and never tested standalone use. Confirmed: `@adhd/*` are tsconfig path aliases only (not node_modules) → `node dist/index.js` AND bare `npx tsx index.js` both fail `Cannot find module '@adhd/apigen-core'`; only `npx tsx --tsconfig tsconfig.base.json` (in-repo) works. Built `bin` still points at `./src/index.ts`; `run` does `await import(userFile)` which node can't do for `.ts`. The DoD has no standalone clause, so the gap was invisible — the consumer-outcome verification (run it independently) caught it. CALLER-DIRECTED corrective (out-of-band, exec-cli-standalone): vite bundles workspace deps (self-contained, no publish), real bin+shebang, `tsx` runtime loader for `run`, and `--tsconfig` resolution (explicit → nearest-to-source → builtin default). Threads tsconfig through generateSchemas (ts-morph Project + ts-json-schema-generator config). Supersedes F25 (the real bin replaces the broken `npx tsx src/index.ts` entrypoint). TODO after: add a standalone DoD clause + update probe_mcp.mjs to drive the built bin, before audit-final.

<!-- F26 dispatch 1 (exec-cli-standalone, sonnet): NON-DELIVERY — went idle with zero changes (no commit, vite still externalizes /^@adhd/, bin unchanged, no tsx/resolver/threading). Standalone /tmp verify failed: Cannot find module @adhd/apigen-core. Escalating to opus (tier-ladder reflection). Tree clean (no partial mess). -->

### F27 — structured logging across TS plugins (caller-directed) [DONE + verified]
Servers were 100% silent (verified 0 bytes). Added common **pino** logging (+ pino-pretty colored, pino-http for express) in `@adhd/apigen-runtime` (`createLogger({level,format,destination})`), threaded via `PluginInput/RunInput.logger`; CLI flags `--log-level/--log-format json|pretty/--log-file` (+ APIGEN_LOG_* env). Logs: compiling · server start · host+port · route/tool list · per-request · shutdown. Commit 5400882. Bundling pitfall handled (pino transports kept external + dependency-checks ignored). VERIFIED independently: fastify shows all 5 log types on stderr (stdout 0 bytes), curl returns correct value; **mcp stdio stdout = 0 bytes / 0 log leaks** (logs on stderr — protocol-safe); json→valid jsonl; level=error suppresses info; --log-file routes to file (0 on stderr). run-many test/lint/build across 6 apigen packages all rc=0.

### Remaining before audit-final (F25/F26 follow-up)
probe_mcp.mjs + README DoD entrypoints still use in-repo `npx tsx src/index.ts`; now that the real bundled bin exists, point them at `node dist/.../index.js` (or the linked `apigen-cli` bin) + add a standalone DoD clause, so audit-final tests the real consumer path.

### F28 — default/CJS-wrapped exports crashed dispatch (caller-found bug) [FIXED commit 3e0d1d9]
User ran `run --source humanize.ts --type api-fastify` (humanizeBytes is `export default`) → 500 `TypeError: fns[name] is not a function`. Root cause: schema extraction names the function by its DECLARATION name (`humanizeBytes`), but the runtime `import()` returns it under `default` — and for CJS-compiled deps (transform is module:commonjs) it's DOUBLE-wrapped (`mod.default.default`, plus a `module.exports` key). The fn-table (`Object.entries(mod)` keyed by export key) never had `humanizeBytes`. FIX: `buildFnTable(mod)` in @adhd/apigen-runtime — recursively unwraps default/module.exports layers and keys every function by its `.name` (recovering default + CJS-wrapped fns), plus named exports by key, plus default-object spread. Applied to CLI run + run-registry AND all 4 generated-server templates (fastify/express/mcp/cli emitted `import * as ns` + `buildFnTable(ns)`). Updated stale exact-string spec assertions (dispatch-import + `_fns`→`_ns`) to robust regexes. Verified: `curl -X POST .../humanizeBytes -d '{"data":{"bytes":234567,"decimals":3}}'` → `229.069 KiB`. 8 projects test/lint/build rc=0.
NOTE (user UX, not bugs): (1) the persistent 400 was `curl -X post` (lowercase) — Fastify matches only `POST`; (2) args must be wrapped `{"data":{...}}` (the envelope contract, shown in route logs); (3) a stale server on :3000 (EADDRINUSE) was masking rebuilds.

### F29 — function naming inconsistent across extraction↔runtime; multiple export shapes broken (class: planner, type: fix-extraction) [FOUND, not yet fixed]
Root pattern: extraction (apigen-core, ts-morph) names functions by the DECLARATION identifier; runtime keys by EXPORT name/fn.name. They agree only for `export function f` — which is the ONLY shape the fixtures covered (why F28 + these slipped). Empirical matrix (api-fastify, real /tmp files):
- ✅ `export function f`, `export const f = ()=>{}`, `export default {a,b}` (object), `export default function f(){}` (named, fixed F28).
- ❌ `export default function(){}` (anonymous) → route `/` (empty name).
- ❌ `module.exports = {f}` (CJS-source .ts) → 0 routes (ts-morph sees no ESM export).
- ❌ `export { x as y }` (renamed/re-export) → route uses `x` (declaration), not `y` (export alias) → uncallable. MOST likely to hit real code (barrels/re-exports).
Shared across ALL plugins (extraction is in apigen-core; every plugin consumes the same schemas). F28 fixed only the runtime half (buildFnTable); these are the extraction half — the wrong/missing name is baked into route+schema, so buildFnTable can't save them.
FIX: name by exported symbol (ts-morph `getExportSymbols()`/export specifiers, honoring `as` aliases) + handle module.exports + anonymous-default; then both layers agree by construction. + add an export-shape test matrix fixture so this regresses loudly.
WHY MISSED (meta): fixtures only covered named exports; extraction & runtime tested in isolation (run.spec imported registerRunCommand with hand-built fn tables, never a real import()); no real-file full-chain integration. Classic green-tests/broken-consumer (CLAUDE.md §6).

---

## REPLAN — v2 canonical standard (planner-class, 2026-06-22, $SKILL 0.8.21)

**Trigger:** `docs/apigen/SPEC.md` (committed f810e9c) supersedes the v1 TS-only design. Recorded as `state-transition.js audit-cli --amend --class planner --type replan` (exit 2, expected escalation marker). The v1 plan was paused at GATE-B (after `cli-run-cmd`, before `audit-cli`); v1's contract-specific verification is folded into v2 (the "option b" the caller leaned to).

**Graph mutation (all via `plan-scaffold.js` 0.8.21 — scripts own dag/state):**
- Rewired v1 tail: `rename-state audit-final→audit-final-v2`, `rename-state integration-tests→integration-tests-v2` (rename auto-repoints dependents incl. terminal `done`), `remove-state audit-cli --cascade`. The 18 complete v1 states are untouched (immutable foundation = "first TS host", SPEC §15).
- Added 5 phases: **v2-core · v2-harness · v2-projection · v2-packaging · v2-verify**.
- Added 17 states + repurposed 2: v2-core (`canonical-descriptor`, `naming-helpers`, `ts-extractor-by-symbol`, `audit-v2-core`); v2-harness (`layer-harness`, `central-validation`, `error-taxonomy`, `audit-v2-harness`); v2-projection (`plugin-interface`, `projection-transports`, `logger-layer-plugin`, `mount-plugins`, `audit-v2-projection`); v2-packaging (`package-restructure`, `unified-cli`, `gateway`, `conformance-vectors`); v2-verify (`integration-tests-v2`, `audit-final-v2`). Tail: `done → audit-final-v2 → integration-tests-v2 →` all v2 frontier `→ canonical-descriptor → core-types` (complete).
- F28/F29 resolved at the right layer: `ts-extractor-by-symbol` names by EXPORTED symbol (export-shape matrix proven by `audit-v2-core` + `integration-tests-v2`).
- DoD: v1 behavioral clauses (dod.1/2/3/4/5/cli) re-pointed `delivered-by → integration-tests-v2` (kept as v2 regression guard). Added **dod.9** (export-shape/F28-F29), **dod.10** (central validation), **dod.11** (metadata envelope), **dod.12** (mixed-host gateway), **dod.13** (unified CLI --type/--use), each bound to a `phase_final()` audit-check stub (forcing function) with entrypoint fidelity + distinctive negative-control.

**Reconcile (all green):** gap-check PASSED (0 warn) · integrity-check clean · env-pin-check --strict 39/39 pinned · `current_state = canonical-descriptor` (in_progress, v2 frontier) · counts 19 complete / 1 in_progress / 19 pending.

**GATE-C (next, before executor dispatch):** wave 1 = `canonical-descriptor` (sole frontier; deps=core-types✓). **Serialize the v2 audits** (`audit-v2-core/harness/projection` + `audit-final-v2` all write `scripts/audit_apigen.py`) and **`conformance-vectors` vs `package-restructure`** (share `conformance/project.json`) — board flagged both write-conflicts.

### Replan Findings (skill + orchestrator)
- **F30 — `rename-state` propagation gap.** It repoints `depends_on`, contexts, criteria.json, audit-script `[id]` tokens, and blockers — but NOT `references.json` `audit_check` IDs nor README DoD `delivered-by`/`entrypoint`/negative-control tokens. Left 5 gap-check FAILs after the two renames; repaired by hand-editing those authoring files (the only path — no edit-ref/edit-dod command). *Proposed amendment (class: planner, type: fix-tooling): extend rename-state to rewrite references.json + README clause tokens.*
- **F31 — `add-state` cannot set `model`/`effort`.** Scaffold-authored nodes carry no tier annotation (board shows `unrated`). Orchestrator must supply tiers at dispatch via `--model/--effort` on `orchestrate-plan --decide`. *Proposed: add `--model/--effort` to add-state.*
- **F32 — `remove-state` resets `current_state` to `nodes[0]`** (a completed state); `orchestrate-plan --dispatch` keys off `current_state` and would re-dispatch a done state. No `set-current-state` command exists; corrected via the sanctioned `state-transition.js canonical-descriptor --start` (idempotent/resumable). *Proposed: a `set-current-state` scaffold command, or have remove-state pick the ready frontier.*
- **F33 — `add-state` on an existing slug overwrites its context** with a fresh scaffold (used intentionally to repurpose the v1 tail; would silently destroy a rich context otherwise). Note for future updates.
- **F34 — DoD↔audit fidelity is coupled at authoring time (working as intended, costly).** A behavioral `[dod.N]` will not pass gap-check until a `check()` command literally contains the entrypoint's distinctive token AND an assert marker AND a negative-control sharing that token. Added stub commands naming the future spec paths (fail-until-built forcing function); `audit-final-v2`'s executor implements real teeth + proven negative controls.

### v2 executor routing (00-active, tiers to apply at dispatch)
| state | executor | tier |
|---|---|---|
| canonical-descriptor, plugin-interface, layer-harness, central-validation, ts-extractor-by-symbol, naming-helpers, error-taxonomy, conformance-vectors | typescript-pro | sonnet |
| projection-transports, mount-plugins, logger-layer-plugin, unified-cli, gateway | backend-developer / typescript-pro | sonnet |
| package-restructure | refactoring-specialist | sonnet |
| integration-tests-v2 | test-automator | sonnet |
| audit-v2-core / -harness / -projection | code-reviewer | opus |
| audit-final-v2 | code-reviewer / security-auditor | opus |

---

## REMEDIATION AMENDMENT (2026-06-22) — folds architect reviews (plan R1–R13 + design Tenet 1/D1–D11)

Recorded as `--amend --class planner --type replan` on `canonical-descriptor` (blocked, exit 2). Proposal: `replan-amendment-proposal.md`. Reviews: `replan-architect-review.md` (plan) + `docs/apigen/SPEC-design-review.md` (design). Caller decisions: **H1 real Python host** · **H2 classes static+instance-opt-in now** · **H3 defer neutral codegen**.

**Applied & verified (gap-check PASSED 0-warn · integrity clean · env-pin 45/45):**
- **+2 phases** `v2-scaffold`, `v2-host-contract`; **+6 states** `scaffold-v2-common`, `scaffold-v2-ts-plugins`, `class-exports`, `streaming-projection`, `python-host`, `audit-v2-host`.
- **R3/R6** — 9 new packages now scaffolded in **final §12 homes** (common ×6 incl. `apigen-schema`; ts-plugins ×3); `package-restructure` becomes a verify gate. Dep edges added so each fill-state depends on its scaffold.
- **R1** — `audit_apigen.py` now defines + registers `phase_v2_core/harness/projection/host`; the v2 audit guards run (exit 1 fail-until-built, no more argparse-2). Real-spec command stubs with negative-control TODOs for the audit executors.
- **R5** — real DAG edge `package-restructure → conformance-vectors`. **R13** — `anonymous-default` + CJS shape fixtures added to `integration-tests-v2`. **R7** — `dod.6` → `nx run-many -t build -p apigen-*` (full v2 set), gated after restructure.
- **Design folded into state scope** (per-state, via node notes): `safe`/live-`query`/`$defs`-IR → `canonical-descriptor`; collision + verb-from-safe + envelope-binding → `naming-helpers`; exported-symbol + shape matrix → `ts-extractor-by-symbol`; §8.1 → `layer-harness`; §9.1 → `projection-transports`; full streaming → `streaming-projection`; §13.1 failure model → `gateway`; §10 → `class-exports`; §14 real host → `python-host`.
- **Frontier:** `current_state = scaffold-v2-common` (started). Counts: 19 complete · 1 in_progress · 24 pending · 1 blocked (`canonical-descriptor`, unblocks on `--start` once deps clear).

**Decision: teeth via audit-phase checks, not per-work-state `criteria.json` (R2 mitigation).** Matches the v1 pattern (work states build; audit states verify via `audit_apigen.py` phases driving real specs). The v2 audit phases carry the acceptance checks; per-state declarative criteria can still be layered later if desired.

**DoD CLOSED (caller-confirmed 2026-06-23, `--confirm-dod`):** `dod.1/2/5` repointed to the **F26 built bin** (`node packages/apigen/cli/dist/index.js`; `tsx src/index.ts` can't resolve `@adhd/*` paths — F25/F26) with a `[v2.bin-built]` build gate at the top of `phase_final`; **new behavioral clauses** dod.14 streaming (in-band error-after-first-chunk + mid-stream cancel), dod.15 safe/verb out-of-source override, dod.16 collision-is-hard-error, dod.17 gateway partial-availability, dod.18 class static+instance, **dod.19 real-consumer capstone** (built bin exposes **unmodified `@adhd/transform`** → a real MCP/HTTP client deep-equals direct in-process calls; `APIGEN_LIVE=1` runs a real model). All bound to `phase_final` checks with entrypoint fidelity + distinctive negative-controls. **`dod_provenance.dod_ids` = dod.1–19 + dod.cli (20 clauses).** Final reconcile: gap-check PASSED (0 warn) · integrity clean · env-pin 45/45.

**Amendment fully closed.** Plan is dispatch-ready from `scaffold-v2-common`.

---

## EXECUTION (2026-06-22) — driving the v2 plan wave-by-wave

**Preflight (re-run at execution start):** board compiles (no cycle, critical-path cost 26) · gap-check PASSED (0 warn) · env-pin 45/45 PINNED · cross-plan clean · **human-blockers: none** (`[]`). $SKILL pinned to **0.8.21** (the version this plan was amended on; 0.8.22 exists but switching mid-flight risks a behavior shift).

**Live ready-frontier (from `dag.json` deps + `state.json` status, NOT the board's whole-DAG waves):** 3 states — `scaffold-v2-common` (in_progress), `canonical-descriptor` (blocked, deps met), `scaffold-v2-ts-plugins` (pending, deps met). All `unrated` (added via `add-state`, no `--model/--effort` — F31); orchestrator-assigned tiers below, divergence noted.

**F35 (NEW — reservation/guard gap):** the two scaffold states declare only `project.json` reservations, but their guards run `nx build` over the new projects — which requires full nx wiring (`package.json`, `tsconfig.json`, `tsconfig.lib.json`, `vite.config.ts`, `src/index.ts`) **plus `tsconfig.base.json` path entries**. Both scaffold states must edit the **shared `tsconfig.base.json`** → latent same-wave write-collision invisible to the board (under-declared reservation). *Proposed planner fix:* widen each scaffold state's `mutates` to the full wiring set incl. `tsconfig.base.json`. *Orchestrator mitigation now:* **serialize the two scaffolds**; run `canonical-descriptor` (core/ only) in parallel with the first.

**F36 (NEW — weak work-state guards):** `canonical-descriptor`'s guard `nx build apigen-core` passes even with a stub descriptor (core already builds); real teeth are deferred to `audit-v2-core`. Orchestrator must **verify the descriptor's content state-side** (read `descriptor.ts`), not trust guard-green. Same pattern for other v2 work states.

### Wave 0 routing (recorded pre-dispatch)

| slug | wave/batch | executor | tier | guard | reduction_ratio |
|---|---|---|---|---|---|
| scaffold-v2-common | w0·b1 | typescript-pro | sonnet/low | `nx run-many -t build -p apigen-naming…codegen-openapi` (6 pkgs) | 0.9961 |
| canonical-descriptor | w0·b1 | typescript-pro | **opus** (load-bearing; plan unrated — divergence) | `nx build apigen-core` | 0.9970 |
| scaffold-v2-ts-plugins | w0·b2 | typescript-pro | sonnet/low | `nx run-many -t build -p apigen-ts-plugin-{logger,openapi,health}` | 0.9965 |

### Wave 0 outcomes

| slug | executor | tier | guard-exit | retries | outcome | notes |
|---|---|---|---|---|---|---|
| scaffold-v2-common | typescript-pro | sonnet | 0 (orch-verified) | 0 | ✅ complete | 6 pkgs build green. Executor went idle pre-`--complete`; orchestrator drove `--complete` after state-side guard verify. `audit_exit:2`/`audit_pass:false` = benign 0-criteria quirk (Track-B: work states carry no per-state criteria), state advanced normally. Token telemetry → byte proxy (SendMessage unavailable to re-engage idle executor). |
| canonical-descriptor | typescript-pro | **opus** | 0 | 0 | ✅ complete | State-side content verified (F36): all 12 §4 Operation fields, JSON-Schema-2020-12+`$defs` IR, `x-apigen-*`+`fidelity`, `Segment{raw,words}`, deterministic-not-refactor-stable `id` w/ Tenet-1 JSDoc, `safe` kind-defaults+verb-decouple. `descriptor.schema.json` valid draft/2020-12 (12 props). Exported from core index. Executor self-completed. High fidelity. |

**F37 (NEW — executors stop before `--complete`):** both batch-1 executors did the work + passed guards but one (scaffold-v2-common) went idle without the `--complete` transition. Orchestrator must always verify state-side and drive `--complete` when an executor idles pre-transition. Because `SendMessage` is not enabled in this orchestrator context, idle executors cannot be re-engaged for their token counts → telemetry degrades to byte-proxy. *Mitigation for future dispatches:* make the `--complete` step the FIRST instruction the executor cannot skip, or accept orchestrator-driven completion as the norm.

### Wave 1 routing (recorded pre-dispatch) — Batch A (4 logic states, parallel; no write-conflicts)

| slug | executor | tier | guard | SPEC ref | reduction_ratio |
|---|---|---|---|---|---|
| naming-helpers | typescript-pro | sonnet | `nx test apigen-naming` | §5 verb-from-safe + override + collision invariant; §9.1 envelope binding | 0.9971 |
| layer-harness | typescript-pro | sonnet | `nx test apigen-runtime` | §8.1 Layer semantics | 0.9972 |
| error-taxonomy | typescript-pro | sonnet | `nx test apigen-errors` | §9.1 gRPC codes + streaming error carriers | 0.9971 |
| plugin-interface | typescript-pro | sonnet | `nx build apigen-core` (weak → verify content) | §7 capabilities {target,layer,mount,envelope} | 0.9972 |

`scaffold-v2-ts-plugins` held to Batch B (sole `tsconfig.base.json` writer; avoid read-during-write race; nothing in next waves needs it yet).

### Wave 1 outcomes — Batch A

| slug | executor | tier | guard-exit | retries | outcome | notes |
|---|---|---|---|---|---|---|
| naming-helpers | typescript-pro | sonnet | 0 | 0 | ✅ complete | `nx test apigen-naming` exit 0 (orch-verified). Self-completed. |
| layer-harness | typescript-pro | sonnet | 0 | 0 | ✅ complete | `nx test apigen-runtime` exit 0 (full suite incl. v1). Self-completed. |
| error-taxonomy | typescript-pro | sonnet | 0 | 0 | ✅ complete | §9.1/§11: ERROR_CODES + 4 transport maps + ApiError + StreamingErrorCarrier verified. Idle pre-complete → orchestrator drove `--complete`. Byte-proxy telemetry. |
| plugin-interface | typescript-pro | sonnet | 0 | 0 | ✅ complete | §7 capability interface {target,layer,mount,envelope} + Call/Next/Chunk/Harness verified state-side (not stub). Idle pre-complete → orchestrator drove `--complete`. Byte-proxy telemetry. |

F37 recurring: 3 of 6 executors so far idle before `--complete`; orchestrator drives it post state-side verify. Normal operating mode for this run.

**F38 (NEW — ts-plugin path/name mismatch):** `scaffold-v2-ts-plugins` scaffolds `packages/apigen/ts/plugins/{logger,openapi,health}` (projects `apigen-ts-plugin-*`), but its consumer fill-states write the interim home `packages/apigen/plugins/{logger,openapi,health}`, and `package-restructure` later moves interim→final — colliding with the scaffold's skeletons. *Orchestrator action:* **defer `scaffold-v2-ts-plugins`** (only consumers are wave-8 `logger-layer-plugin`/`mount-plugins`); reconcile via a proposed planner amendment (canonicalize the ts-plugin home + nx project names across scaffold/fill/restructure) before dispatching those waves.

### Wave 2 routing (recorded pre-dispatch) — 3 disjoint logic states, parallel

| slug | executor | tier | guard | SPEC ref |
|---|---|---|---|---|
| ts-extractor-by-symbol | typescript-pro | sonnet | `nx test apigen-core` | name-by-exported-symbol (F28/F29); safe-default-from-kind; query=live; x-apigen hints; export-shape matrix incl anonymous-default + CJS (R13) |
| central-validation | typescript-pro | sonnet | `nx test apigen-runtime` | §6 validation Layer + necessary-but-not-sufficient |
| projection-transports | typescript-pro | sonnet (escalate→opus on guard fail) | `nx run-many test api-fastify/api-express/mcp/cli` | §9.1 envelope-from-metadata + §5 verb-from-safe across 4 transports |

### Wave 2 outcomes (partial — ts-extractor-by-symbol still running)

| slug | executor | tier | guard-exit | retries | outcome | notes |
|---|---|---|---|---|---|---|
| central-validation | typescript-pro | sonnet | 0 | 0 | ✅ complete | §6 validateLayer short-circuits invalid_argument; necessary-not-sufficient documented + tested. Self-completed. |
| projection-transports | typescript-pro | sonnet | 0 (⚠ under-tested — see F39) | 0 | ✅ complete | §9.1 envelope binding + §5 verb-from-safe across 4 transports. cli generate.ts uses `envelopeCliFlag/envelopeEnvVar` from apigen-naming. Self-completed. Guard ran only 3/4 (F39); orchestrator independently ran `nx test apigen-plugin-cli-output` → exit 0, confirming the cli transport too. Work sound. |

**F39 (NEW — guard names a non-existent project → false-green):** `projection-transports` guard (`dag.json:649`) lists `apigen-plugin-cli`, but the real nx project is `apigen-plugin-cli-output` (renamed in v1, see transition log). `nx run-many` silently skips unknown projects → guard ran 3/4 and passed without testing the cli transport. *Proposed planner fix (amendment, can't hand-edit dag.json):* change the guard's `apigen-plugin-cli` → `apigen-plugin-cli-output`. *Orchestrator mitigation:* always verify cli-plugin states under the correct project name (done here; cli tests green). No halt — work verified sound by direct test.

| ts-extractor-by-symbol | typescript-pro | sonnet | 0 | 0 | ✅ complete | extract.ts covers all 6 export shapes (named fn/const/object, default-fn, **anonymous-default**, **CJS** per R13); names by exported symbol (fixes v1 F28/F29); extract.spec.ts. `nx test apigen-core` exit 0. Self-completed. |

**F40 (CRITICAL — concurrent `--complete` lost-update / status flapping):** `state-transition.js` read-modify-writes `state.json` without a lock. When parallel executors self-`--complete` (and re-read at `--start` time vs write at `--complete` time across overlapping windows), a later write can clobber an earlier completion. Observed: `projection-transports` completed @02:50 then **flapped in_progress↔complete** across orchestrator reads as `ts-extractor`'s @02:57 write interleaved; settled to `complete`. Full status audit confirms no PERMANENT loss (9/9 expected-complete are complete), but the hazard is real. **Protocol change adopted from wave 3 on:** *all `state.json` mutations are serialized through the orchestrator* — executors do **work + pass guard + STOP** (no `--start`/`--complete`); the orchestrator runs `--start` before dispatch and `--complete` sequentially after state-side verify. Eliminates the race while preserving work-parallelism. *Proposed tooling fix:* `state-transition.js` should take an flock on `state.json` (or use atomic CAS on a version field).

**Waves 0–2 COMPLETE: 9/9 v2 work states done & verified (gap-check-clean packages, all guards green).** Frontier → first audit gate `audit-v2-harness` (mandatory-halt-on-fail).

### Wave 3 — AUDIT GATE cleared

| slug | executor | tier | guard-exit | outcome | notes |
|---|---|---|---|---|---|
| audit-v2-harness | orchestrator (deterministic Track-B) | n/a | 0 | ✅ GATE PASSED | `audit_apigen.py --phase v2-harness` 3/3 checks (invoke §8.1 / validation invalid_argument short-circuit / errors per-transport maps). All 3 filters verified to hit real specs (invoke.spec.ts, validate-layer.spec.ts, errors.spec.ts) before trusting. `--complete` audit_pass=True → conformance-vectors. Mandatory-halt-on-fail gate: did NOT fail, cleanly advanced. |

### Wave 3 Batch A outcomes (F40 protocol: orchestrator-driven transitions)

| slug | executor | tier | guard-exit | outcome | notes |
|---|---|---|---|---|---|
| conformance-vectors | typescript-pro | sonnet | 0 | ✅ complete | vectors.ts categories A round-trip / B naming+collision / C envelope / D error-map / E necessary-not-sufficient. `nx test apigen-conformance` exit 0. Orchestrator `--start`+`--complete` (executor did work+guard only — no state.json race). `audit_failed`=benign 0-criteria quirk; state complete. |

**USER QUESTION (wave 3, mid-flight): "Are we utilizing the previously built nx generator and plugins?"** Investigated against code:
- **v1 plugins REUSED** — `projection-transports` upgraded mcp/fastify/express/cli in place (not rebuilt); core/runtime/schema extended.
- **`apigen-nx:plugin` generator NOT yet used** but dry-run confirms it scaffolds a full plugin at `packages/apigen/plugins/<name>` (project `apigen-plugin-<name>`, auto-updates tsconfig.base.json). This is the right tool for the deferred `scaffold-v2-ts-plugins` (logger/openapi/health ARE plugins).
- **F38 ROOT CAUSE (upgraded):** generator + fill-states (`logger-layer-plugin`, `mount-plugins`) already agree on `packages/apigen/plugins/<name>` + `apigen-plugin-<name>`. Only `scaffold-v2-ts-plugins`'s `ts/plugins/<name>` + `apigen-ts-plugin-<name>` (BOTH artifacts and guard) are the outliers. *Fix:* dispatch that state via `nx g @adhd/apigen-nx:plugin` + propose planner amendment to repoint its guard/artifacts to the `apigen-plugin-*` @ `plugins/` convention (dogfoods generator, closes F38).
- **Minor:** `scaffold-v2-common`'s 6 libs hand-copied core's wiring instead of `./generate-lib.sh` (libs, not plugins — apigen-nx N/A). Builds green; logged.

## AMENDMENT (2026-06-23, user-directed) — dogfood apigen-nx generator (v2 shape) + deprecation hygiene

User directives: (1) "it should be upgraded to support the new system and utilized in the plan to ensure consistent shape"; (2) "make sure any packages we're deprecating are fully removed from the nx workspace". Recorded via `--amend --class planner --type fix-guard` on `scaffold-v2-ts-plugins` (→ blocked, exit 2 marker; approved by caller directive).

**Applied (gap-check PASSED 0-warn · env-pin 46/46 · integrity clean · deprecation check passes live):**
- **+1 state `nx-generator-v2`** (phase v2-scaffold; deps plugin-interface, layer-harness; guard `nx test apigen-nx`; artifacts = generator.ts + 3 `__files__` templates + schema.json). Upgrades `@adhd/apigen-nx:plugin` to emit the **v2 plugin shape** (§7 capabilities `{target,layer,mount,envelope}` + Layer-aware), so every plugin shares ONE generator-produced shape.
- **Repointed `scaffold-v2-ts-plugins`** (closes F38): now depends on `nx-generator-v2`; guard `nx run-many -t build -p apigen-plugin-{logger,openapi,health}`; artifacts `packages/apigen/plugins/{logger,openapi,health}/project.json`; context = DOGFOOD via `nx g @adhd/apigen-nx:plugin <name>`. The `ts/plugins/` + `apigen-ts-plugin-*` outliers are gone.
- **Fixed stale guards:** `mount-plugins` `apigen-openapi`→`apigen-codegen-openapi`; `phase_v2_projection` plugin check `apigen-ts-plugin-*`→`apigen-plugin-*`.
- **Deprecation hygiene (directive 2):** added `v2-projection.deprecation-hygiene` audit check — asserts NO `packages/apigen/ts/` dir and NO `apigen-ts-plugin-*` project ever remain. Added `v2-projection.generator-v2-shape` check (`nx test apigen-nx`) so the gate proves the generator emits v2 shape. **Current workspace verified clean: 15 apigen projects, all final §12 homes, no orphans, no `ts/` dir.**
- Generator default home (`packages/apigen/plugins/<name>`, project `apigen-plugin-<name>`) already matched the fill-states — so dogfooding is drop-in.

### Wave 3 Batch B + amendment outcomes

| slug | executor | tier | guard-exit | outcome | notes |
|---|---|---|---|---|---|
| class-exports | typescript-pro | sonnet | 0 | ✅ complete | §10/H2: extract-classes.ts (static→action ops always; instances opt-in via includeInstances → constructor+instance-method ops); instance-registry.ts (TTL sweeper + dispose/disposeAll). nx test apigen-core exit 0 + nx build apigen-runtime green (F41 self-check). Orchestrator-driven --complete. |
| nx-generator-v2 | typescript-pro | sonnet | 0 | ✅ complete | apigen-nx:plugin emits v2 shape (capabilities {target,layer,mount,envelope}, Layer-aware Call/Next/Chunk per §7.1/§8.1); test template asserts capabilities; home/name unchanged (packages/apigen/plugins/<name>, apigen-plugin-<name>); +--platform option; NO ts/plugins or apigen-ts-plugin introduced. nx test apigen-nx exit 0. Content verified by reading templates. |

**13/27 v2 states complete.** `scaffold-v2-ts-plugins` deps now met (scaffold-plugins ✓, nx-generator-v2 ✓) → ready to dispatch (will dogfood the upgraded generator).

### ⛔ HALT — audit gate `audit-v2-core` FAILED (3/4), mandatory halt (not crossed)

`audit_apigen.py --phase v2-core`: ✅ v2-core.descriptor, ✅ v2-core.naming-collision, ✅ v2-core.classes; ✗ **v2-core.export-shape**. Did NOT mark complete. Two root causes (evidence-based):

- **F42a (audit mis-wiring/ordering):** `v2-core.export-shape` runs `nx test apigen-cli export-shape-matrix`, but `export-shape-matrix.spec.ts` is owned by `integration-tests-v2` (wave 14, not yet built). With no file match the runner **degrades to the whole apigen-cli suite**. The extractor's shape-matrix was actually proven by `ts-extractor-by-symbol` in `apigen-core/extract.spec.ts`. *Fix-A (verified):* repoint the check to `nx test apigen-core extract` (→ passes); keep the cli `export-shape-matrix` assertion for `phase_integration`/`audit-final-v2` where that test exists.
- **F42b (real flaky live test):** the whole-suite fallback hits `cli/run.spec.ts` `[cli-run-cmd.1 live]` MCP streaming-http test which **times out at 5000ms** (setTimeout-polled live server — the timing hazard CLAUDE.md §6 bans). *Fix-B:* gate it behind `APIGEN_LIVE=1` (matches dod.19 + CLAUDE.md live-test standard; CI/audits stay offline/deterministic) OR make it deterministic (readiness latch + bounded deadline + raised timeout). Bites later regardless (audit-final-v2 runs full cli suite).

Proposed: apply Fix-A (audit-correctness) + dispatch Fix-B (real bug, debugger/test-automator), then re-run the gate. Awaiting caller steer.

### ✅ HALT RESOLVED — audit-v2-core cleared 4/4 (caller approved Fix-A + Fix-B)

- **Fix-A applied:** `v2-core.export-shape` → `npx --yes nx test apigen-core extract` (real shape-matrix proof). 4/4 pass.
- **Fix-B applied** (debugger `fix-live-tests`): gated 5 live-server test blocks behind `APIGEN_LIVE=1` (default-skip): cli `run.spec.ts [cli-run-cmd.1 live]`; api-fastify `run() — real Fastify server` + `[v2-proj-transport] safe→GET/envelope`; api-express `run() — real Express server` + `[v2-proj-transport] safe→GET/envelope`. Default `nx test` now deterministic/offline; live runnable via `APIGEN_LIVE=1`.
- **F43 (watch):** gating the `[v2-proj-transport]` live tests means part of projection-transports' §9.1/§5 proof is now behind APIGEN_LIVE. Re-verify default projection coverage at `audit-v2-projection` (its verb/envelope checks run `nx test apigen-cli canonical`, owned by integration-tests-v2 — likely needs the same forward-ref handling as F42a, and/or an APIGEN_LIVE run).

## PERF FIX (2026-06-23, user-directed) — enable nx `test` caching

User noticed audit/test re-runs crawling. Diagnosed: `nx.json` `targetDefaults` had `cache:true` for `@nx/vite:build`/`@nx/rollup:rollup`/`@nx/js:tsc` but **NO `test` default** → test never cached (never enabled, not disabled). Evidence: identical `nx test apigen-core` repeat took 113s (no reuse). apigen-core tests are ~2min (ts-morph + ts-json-schema-generator compile TS at runtime).

**Fix:** added `targetDefaults.test = {cache:true, inputs:[default, ^production, {externalDependencies:[vitest]}]}` to `nx.json`. **PROVEN:** run1=108.9s → run2=**0.43s** ("existing outputs match the cache"). ~250× on repeats; orchestrator `--complete` guard re-runs now sub-second on unchanged code. Global memory written (`~/.claude/projects/.../memory/nx_cache_usage.md` + index). NOT committed (caller controls commits).

**Cache-correctness PROVEN (caller-requested):** edit `apigen-errors/errors.spec.ts` → cache MISS (50 tests ran); revert → cache HIT + git diff clean. `inputs:[default,...]` (default = {projectRoot}/**/*) correctly captures test files → no stale-hit risk. Probe fully reverted.

**F40 recurrence:** my redundant `class-exports --complete` (launched out of caution) clobbered `nx-generator-v2`'s completion (flapped complete→in_progress). Re-completed. REINFORCED RULE: issue exactly ONE state-transition at a time; never launch redundant/concurrent --complete calls; verify each lands before the next.

| scaffold-v2-ts-plugins | typescript-pro | sonnet | 0 | ✅ complete | DOGFOODED upgraded generator: apigen-plugin-{logger,openapi,health} at packages/apigen/plugins/<name>, v2-shape stubs (capabilities {target,layer} §7.1). Deprecation hygiene verified (no ts/, no apigen-ts-plugin-*). **F38 closed & validated.** Both user directives (generator dogfooding + deprecation removal) proven end-to-end. |

### Wave (v2-projection fills) outcomes — parallel, F40-safe, all verified state-side

| slug | tier | guard-exit | outcome | notes |
|---|---|---|---|---|
| logger-layer-plugin | sonnet | 0 | ✅ complete | logger as v2 Layer (typed-ctx pino §8.1 r3, error propagates, stream-aware). |
| streaming-projection | sonnet | 0 | ✅ complete | §11: runtime/mcp/fastify stream.ts — per-chunk async gen, consumer-pull backpressure, AbortSignal cancel, error-after-first-chunk via apigen-errors carriers. |
| mount-plugins | sonnet | 0 | ✅ complete | to-openapi (Descriptor→OpenAPI 3.1, verb-from-safe) + openapi/health mounts (health _meta feeds gateway readiness §13.1). |

All three filled the v2 generator-produced stubs (consistent shape). nx test cache now makes guard re-runs sub-second.

### ✅ audit-v2-projection — false-green caught, fixed to real teeth, then cleared

Initial run: 6/6 "pass" but envelope/verb/streaming were VACUOUS (ran `nx test apigen-cli canonical/streaming` — specs owned by integration-tests-v2, don't exist → filter degraded to whole-cli-suite pass without asserting behavior). Per CLAUDE.md "no proxy evidence," did NOT clear on that.

**F43 resolved:** gating live tests did NOT drop deterministic projection coverage — generate-level tests exist: apigen-naming (verb-from-safe + envelope keys), api-fastify/express (safeSchema→GET/unsafe→POST in routes), mcp/generate.spec (§9.1 envelope in generated server), runtime/mcp/fastify stream tests.

**Fix (same approved pattern as Fix-A):** repointed the 3 checks to deterministic existing tests — envelope→`nx test apigen-plugin-mcp`, verb→`nx test apigen-plugin-api-fastify`, streaming→`nx run-many test apigen-runtime+mcp+fastify`. cli end-to-end proof stays in phase_final/audit-final-v2 via dod.14/15 (when integration-tests-v2 builds canonical.spec.ts). Re-run: **6/6 with real teeth.** Gate cleared.

### ✅ audit-v2-host — fixed (pytest→run_tests.py + forward-ref deferral), cleared 2/2

Initial: 2/3 with all 3 wrong — v2-host.conformance FAILED (pytest found "no tests"; host ships env-pinned run_tests.py), gateway-mixed + partial-availability VACUOUS (apigen-cli specs owned by integration-tests-v2). Fix: conformance→`python3 packages/apigen/python/run_tests.py` (real, 45/45); collapsed the two vacuous cli checks into `v2-host.gateway-contract`→`nx test apigen-gateway` (deterministic §13.1 routing/partial/deadline via HostAdapter). **Real TS↔Python e2e (mixed-host + kill-sidecar) DEFERRED to audit-final-v2 via dod.12 + dod.17 — integration-tests-v2 MUST build those cross-host apigen-cli specs driving the real Python sidecar.** Re-run: 2/2 real teeth. Cleared.

### F44 (built-bin path wrong) — fixed before integration-tests-v2

`dod.1/2/5/cli/19` + `[v2.bin-built]` gate + 7 audit `--cli` probes referenced `packages/apigen/cli/dist/index.js`, but nx outputs to `dist/packages/apigen/cli/index.js` (outputPath/vite outDir = workspace-root dist). 12 refs (4 README dod entrypoints + 8 audit) repointed `packages/apigen/cli/dist/index.js` → `dist/packages/apigen/cli/index.js` (consistent in both so Check-8 token-match holds). Verified: bin builds+exists at correct path, gap-check PASSED 0-warn, env-pin 46/46. Would have failed audit-final-v2 (phase_final [v2.bin-built]) + dod.19 real-consumer.

### Wave: integration-tests-v2 (capstone) dispatched — opus

Builds the consumer-outcome proofs the DoD rests on: canonical (envelope/verb), export-shape-matrix (named/renamed/default-fn/default-object/anonymous/cjs), **gateway-mixed-host (REAL TS↔Python sidecar, deferred from audit-v2-host — dod.12)**, **gateway partial-availability (dod.17)**, streaming (dod.14), **real-consumer capstone (dod.19 — built bin dist/packages/apigen/cli/index.js on UNMODIFIED @adhd/transform, real client deep-equals in-process, APIGEN_LIVE real model)**. REAL components, no mocks (CLAUDE.md §6).

### ⛔ HALT — audit-final-v2 (final DoD gate) 107/117, 10 failures — NOT crossed

**ALL v2 feature clauses PASS** (dod.9–19: export-shape, validation, envelope, mixed-host, unified-CLI, streaming, verb-override, collision, partial-availability, classes, real-consumer; + dod.1-live, dod.6). The v2 system is proven. The 10 failures are v1-regression / wiring / probe / one dropped spec — root-caused with evidence:

| failures | root cause | fix | owner |
|---|---|---|---|
| dod.1, dod.1-sse, dod.1-streaming-http, dod.2, dod.5, dod.cli (6) | **`probe_mcp.mjs` bug**: ground-truth via `tsx --eval` uses TOP-LEVEL `await` → "not supported with cjs output". Bin itself works (verified). | wrap eval await in async IIFE / emit ESM | dispatch (debugger/js-pro) |
| audit-final-v2.schema-teeth (+ dod.3/4 secretly vacuous) | `integration-tests-v2` **dropped `integration/schema.spec.ts`** → filter degrades to whole-suite vacuous pass; schema-teeth correctly flags missing spec | restore `schema.spec.ts` (ctx-exclusion + middleware-override teeth) | dispatch |
| audit-cli.5 / inv-type-flag-only | **false positive**: `--output` grep matches `expect(optionNames).not.toContain('--output')` test assertion | exclude `*.spec.ts` from the grep | orchestrator |
| dod.7 | references **non-existent nx target `apigen-cli:generate-api`** (cli targets: test/build only) | add a real `generate-api` target using the apigen-nx `generate` executor (dogfood) | orchestrator |
| dod.8 | **leftover orphan `test-plugin`** (fixed) + non-idempotent check + stale "OutputPlugin" desc | rm test-plugin before/after; desc→v2 capabilities | orchestrator |

Housekeeping: removed orphan `packages/apigen/plugins/test-plugin` (dir + nx project) + its `tsconfig.base.json` path (deprecation directive).

### audit-final-v2 remediation — 5 wiring fixes done; capstone probe caught a REAL v2 bug

Fixed & verified: #3 audit-cli.5 grep excludes *.spec.ts; #4 dod.7 (added apigen-cli:generate-api target dogfooding the executor + executor now prefers local built bin `dist/packages/apigen/cli/index.js` falling back to npx + node:fs added to apigen-nx vite externals; executor spec green, generate-api writes output); #5 dod.8 idempotent (pre/post-clean test-plugin dir + tsconfig path) + v2-capabilities description; #2 restored integration/schema.spec.ts (authored: 'excludes ctx' + 'suppresses session' with literal teeth not.toContain('ctx')/toContain('session')/not.toHaveProperty('session') — both tests green); #1 probe_mcp.mjs top-level-await wrapped in async IIFE + `--transport`/`--port` → `--opt transport=`/`--opt port=` (dod.5 registry PROBE OK).

**BUG-APIGEN-001 (real v2 runtime defect, caught by capstone dod.1):** functions with a `ctx` first param (getUser/listUsers) return WRONG results through the generated MCP server — `callTool(getUser,{data:{userId:'abc'}})` → `{}` but direct `getUser(ctx,'abc')` → `{id:'abc'}`. The domain arg is dropped when ctx is present. Non-ctx functions (createUser/ping/sendEmail, dod.5 registry tools) work. Persists after fresh no-cache rebuild → genuine dispatch/mcp-run defect, not stale bundle. Blocks dod.1/1-sse/1-streaming-http/2/cli. Dispatching debugger to fix the ctx+data arg mapping.

### audit-final-v2 now 114/117 (was 107). BUG-001 FIXED.

BUG-APIGEN-001 fixed (hasCtx threaded core→runtime; dod.1 stdio + dod.1-streaming-http now PASS; core/runtime/cli green). 5 wiring fixes confirmed. **3 remaining failures = 2 real defects:**
- dod.2 + dod.cli → **BUG-APIGEN-002** (generate emits no resolution scaffolding → generated server.ts/cli.ts can't resolve @modelcontextprotocol/sdk outside the repo tree). Fix in apigen-cli generate.
- dod.1-sse → **BUG-APIGEN-003** (v2 MCP SSE transport unreachable — /sse fetch failed; stdio + streaming-http work). Fix in mcp plugin SSE mode.
Both are genuine consumer-outcome gaps caught by the capstone. All v2 FEATURE clauses (dod.9–19) pass.

### ✅ audit-final-v2 CLEARED — 117/117, all DoD clauses proven

3 fixes landed: BUG-001 (ctx-dispatch, hasCtx threaded), BUG-003 (MCP SSE transport via fix-sse), BUG-002 (generate portability — **Option A "publish" model**: `generate` emits a clean publishable package.json with real `^<version>` deps `@modelcontextprotocol/sdk`/`@adhd/apigen-runtime`/-core + tsconfig; the workspace node_modules+paths bridge demoted to default-off `--link-workspace`, used only by the pre-publish probe). Default output is a clean, npm-installable artifact. gap-check PASSED 0-warn, phase_final 117/117.

## ✅✅ PLAN COMPLETE — 46/46 states done (2026-06-23)

Final DoD gate 117/117 · gap-check PASSED 0-warn · env-pin 46/46 · integrity clean. `done` is terminal; DoD (dod.1-19 + dod.cli, 20 clauses) confirmed + proven against REAL consumers (built bin, real MCP/HTTP clients, real Python sidecar mixed-host + partial-availability, unmodified @adhd/transform capstone). The capstone DoD caught **3 real bugs**, all fixed: BUG-001 (ctx-param dispatch), BUG-002 (generate output portability → Option-A publishable package.json), BUG-003 (MCP SSE transport). NOT committed (caller controls commits). Findings F25-F44 + BUG-001/002/003 logged. Orchestration: 46 states driven wave-by-wave, every outcome verified state-side (not agent prose), F40 serialized transitions, nx test-cache enabled+proven.

**F45 (skill-tooling quirk, NOT a bypass):** integrity-check reports `BYPASS_SUSPECTED done: complete in state.json, no completion event`. Root cause: the terminal `done` node has `kind:"terminal"`, but the installed (0.8.21) `emit-event` validator only accepts `work|audit|review` → it rejects the done completion event, so events.ndjson lacks the mirror line. The completion IS legitimate — `transition_log` has a proper `done` entry (start_ref/end_ref) written by `state-transition.js --complete`. So the false-positive is a skill defect (emit-event should accept `terminal`, or state-transition should map terminal→a valid event kind), not an actual hand-edit/bypass. Plan completion stands: state.json 46/46 complete + transition_log + phase_final 117/117 all agree.
