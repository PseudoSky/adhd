# adhd-environment — Plan Decisions

## 2026-07-08 · Preflight repair (ENV-PLAN-001..007)

Repair round triggered by plan-orchestrator preflight halt at `current_state:
contract-base-spec`. `state.json` was NOT touched; only `dag.json`,
`human-blockers.json`, repo-owned guard scripts, and plan docs.

### F1 (ENV-PLAN-002) — non-JS guards expressed as repo-owned python guard scripts
The env-pin heuristic (`lib/env-pin.js`) recognises only `./node_modules/.bin/`,
`npx --yes|-y`, or a `python3? … .py` script invocation as pinned; there is no
rust/cargo/uv marker, and `PLAN_ENV_LABEL` is a forbidden blanket bypass. So each
non-JS guard is now a `python3 docs/plan/adhd-environment/scripts/guard_<slug>.py`
that resolves its toolchain by absolute path and fails loudly when absent:
- `runtime-py`: `python -m build` → `guard_runtime_py.py` (`uv run --python 3.10 -m build`).
- `runtime-rs`: `cargo build` → `guard_runtime_rs.py` (`rustup run 1.95.0 cargo build`;
  rustup resolved via `which` then `/opt/homebrew/opt/rustup/bin/rustup`).
  Also committed `environment-core-rs/rust-toolchain.toml` (channel 1.95.0).
- `scaffold-workspace`: `test -f …` → `guard_scaffold_workspace.py` (asserts the
  two canonical scaffold manifests; already-complete state, pinned for re-run determinism).

### F4 (ENV-PLAN-001) — docs-steward no-op guard replaced with a behavioral guard
The old guard `test -f …/environment-core-node/README.md` was green before the
state ran (README declared by no state, already on disk). A `test -f` on the real
artifacts (DEMO.md / USE_CASES.md) is the same bug — both already exist. Replaced
with `guard_docs_steward.py`, which asserts CONTENT (DEMO.md carries the cold-start
`nx build environment-*` sequence, an `adhd-env` command, and the
`require('@adhd/environment')` runtime command; USE_CASES.md resolves to the real
entrypoints) AND BEHAVIOUR (builds the shipped node package and executes the demo's
headline command — the built `@adhd/environment` must export a constructable
`Environment` class with `.get()`). Red today (runtime is a scaffold stub exporting
only `environmentEnvironmentCoreNode`), green only once the runtime states ship the
typed client. Verified RED by execution during repair.

### F2 (ENV-PLAN-003) — per-state tier ratings (model / effort)
Opus reserved for the three audit gates and the high-blast-radius refactor; sonnet
for the multi-file implementation states; no state is trivially mechanical enough
for haiku (scaffold, the usual haiku candidate, needed two repair rounds over a
6-package cross-tsconfig/alias family, so it is rated sonnet). Rationale per state:
- `contract-base-spec` — **sonnet/medium**: authors the JSON Schema, cross-language
  test vectors, SPEC, and index barrel — design judgment over multiple coupled artifacts.
- `builder-engine` — **sonnet/medium**: 7-module engine (yaml parse, field merge,
  config resolve, schema gen, provenance, validation, snapshot write).
- `builder-snapshot-api` — **sonnet/medium**: the EnvironmentSnapshot class + barrel + tests.
- `audit-builder` — **opus/hard**: adversarial audit gate; must find gaps, not just confirm green.
- `runtime-core-node` — **sonnet/medium**: the typed `Environment` client (dod.5 headline).
- `runtime-cli` — **sonnet/medium**: 9-command CLI surface over the builder.
- `runtime-py` — **sonnet/medium**: Python runtime parity + contentHash vector.
- `runtime-rs` — **sonnet/medium**: Rust runtime parity + contentHash vector.
- `audit-runtime` — **opus/hard**: audit gate spanning all three language runtimes.
- `refactor-agent-mcp` — **opus/hard**: highest blast radius — rewires the whole
  agent-mcp config graph (index/server/logger/streaming/db) and must preserve 26 legacy
  ADHD_AGENT_* env names; a wrong-tier dispatch here risks a silent secret-resolution regression.
- `audit-final` — **opus/hard**: whole-family final audit gate.
- `docs-steward` — **sonnet/medium**: authors DEMO.md/USE_CASES.md and drives the real
  demo commands; requires reasoning over the shipped surface, not mechanical templating.
- `scaffold-workspace` — **sonnet/medium**: 6-package family + CLI scaffold with
  cross-package tsconfig/alias coupling; empirically not mechanical (two repair rounds).

### F3 (ENV-PLAN-004) — docs-steward bound to a DoD outcome
`docs-steward` bore acceptance criteria but no `delivered-by:`. Its DEMO.md is the
end-to-end proof-of-life that the built packages actually run (its cold-start beat
builds all 6 and asserts exit 0), so it was attached to the existing `[dod.1]`
("All 6 packages build successfully") delivered-by list. No new DoD clause invented —
the DoD is human-confirmed (dod.1..dod.8, pseudosky 2026-07-08).

### F6 (ENV-PLAN-006) — cargo-registry-token rebound to release
`cargo-registry-token` declared `required_by: ["runtime-rs"]`, `blocks_at:
"per-state"`, which would halt wave 2 — contradicting its own description ("needed
only at release/publish time, not for cargo build/test"). `runtime-rs`'s guard is
`rustup run 1.95.0 cargo build`, which never touches crates.io.

The user-approved rebind (2026-07-08) was expressed as `required_by: []` — but an
empty `required_by` is not a valid persisted blocker form: gap-check hard-fails it
(`required_by must be non-empty and name real nodes`), and the skill's own
plan-scaffold logic DELETES any blocker whose `required_by` empties. Deleting the
blocker outright, however, re-trips gap-check's secret-coverage sweep: the release
target `cargo publish --token $CARGO_REGISTRY_TOKEN` is documented in
`contexts/scaffold-workspace.md`, so with no covering blocker the sweep WARNs that
`CARGO_REGISTRY_TOKEN` is referenced-but-unprovisioned. Both the empty-array and the
deletion forms therefore fail the "gap-check clean, 0 warnings" gate.

## 2026-07-09 · Preflight repair round 2 (ENV-PLAN-008..014)

Second repair round, HARD SCOPE: only `dag.json`, `scripts/**`, `human-blockers.json`,
`decisions.md` were touched. `state.json` was NOT modified and `state-transition.js` was
NOT invoked (no `--start`, no `--complete`, no `--amend`); no `git add`/`git commit`.
`current_state` remains `builder-snapshot-api` (5/13 complete). All guard/harness changes
were verified by direct execution and real exit codes.

### F12 (ENV-PLAN-012) — `run-audit.js` phase filter + cwd anchoring
Two bugs fixed in the vendored runner:
- **(a) phase filter was accumulative, keyed off FILE ORDER.** `phaseOrder()` derived the
  ordered phase list from the order criteria appear in `criteria.json`; because the `audit`
  criteria are written first, EVERY `--phase X` dragged in all 12 whole-system `audit`
  checks (`--phase contract` ran `audit-final.*`). Replaced `accumulatedPhases`/`phaseOrder`
  with an EXACT set-membership `selectCriteria`: `--phase X` selects only `phase===X`;
  `--phase X,Y` selects the union of the named phases; empty/absent selects all. This is how
  the composite audit guards scope themselves (e.g. builder gate = `contract,builder`).
- **(b) no working cwd.** Criteria were resolved and executed relative to `process.cwd()`,
  so the runner found no criteria from the repo root and hit `cd: …: No such file` from the
  plan dir. Now `criteria.json` resolves from the SCRIPT DIR (`import.meta.url`) and every
  check executes with `cwd = REPO_ROOT` (walked up to the nx.json marker), so the runner
  behaves identically from the repo root and the plan dir.
- **Self-test:** `run-audit.js --self-test` asserts, purely on the criteria model, that each
  `--phase X` returns ONLY phase-X criteria, that absent-phase returns all, and that a
  comma pair returns exactly the union — passing from BOTH the repo root and the plan dir.

Sub-fix (enabling F11/F13 to reach green): several `present`-kind criteria were mis-kinded —
they grep FILE CONTENT but pointed at a DIRECTORY with a filename pattern, so they could
NEVER match even when the artifact existed (verified: `contract-base-spec.1..3` failed while
the files existed). Converted file-existence checks to `exists` (single path) and multi-path
checks to `command` (`test -f/-d …`), so the harness can actually reach green when a state
completes. `scaffold-workspace.3` (content grep of nx.json) and `runtime-cli.3` (content grep
of set.ts) remain `present` (valid content greps).

### F8 (ENV-PLAN-008) — every compound guard leg independently pinned
`env-pin-check`'s markers are substring tests, so `npx --yes` anywhere in a guard laundered
the rest (`explainPin("npx --yes true && … && cargo build") → pinned`). The offending
`audit-runtime` guard (`… && python -m build && cargo build`) is gone: all three audit guards
are now `python3 …​/guard_audit_*.py` wrappers whose every leg is pinned. Every bare
`python`/`cargo` leg in `criteria.json` (runtime-py.2/.3/.8, runtime-rs.2/.3/.6,
audit-runtime.2/.3) now delegates to the pinned guard scripts. Audited by SUBSTANCE, not by
env-pin's verdict.

### F11 (ENV-PLAN-011) — audit gates invoke the harness, not `nx build`
`audit-builder` → `guard_audit_builder.py` (`run-audit.js --phase contract,builder`),
`audit-runtime` → `guard_audit_runtime.py` (`--phase runtime`), `audit-final` →
`guard_audit_final.py` (all phases + coverage assertions). Verified RED now:
`guard_audit_builder.py` exit 3, `guard_audit_runtime.py` exit 8, `guard_audit_final.py`
exit 1 — each because real acceptance criteria fail, not because packages don't compile. The
`scripts/audit_audit-*.py` artifact names in `dag.json` were LEFT UNCHANGED (only the guard
strings changed) because the matching `contexts/*.md` `mutates` blocks are outside this
round's allowed scope; the guard scripts are plan tooling (like `run-audit.js`), not state
artifacts.

### F9 (ENV-PLAN-009) — work-state guards assert their own behaviour
`builder-snapshot-api`, `runtime-core-node`, `runtime-cli` guards were byte-identical
`nx build` invocations that pass on the nx scaffold stub, so they were green while pending.
Each now asserts its own observable behaviour and is RED today (exit 1, all three):
- `builder-snapshot-api`: `test -f …/environment-snapshot.ts && nx build && node -e` build()
  returns a snapshot exposing get/set/configPath/write (dod.8).
- `runtime-core-node`: `test -f …/environment.ts && nx build && node -e` constructs the typed
  `@adhd/environment` `Environment` (dod.5).
- `runtime-cli`: `test -f api.ts && grep` the 9 command fns `&& nx build environment-cli`.

### F13 (ENV-PLAN-013) — audit-final covers Python + Rust explicitly + coverage count
`--projects=environment-*` silently covers 4/6 packages (core-py/core-rs have no project.json).
Added `audit-final.9` (pinned pytest via `guard_runtime_py.py test`) and `audit-final.10`
(pinned cargo test via `guard_runtime_rs.py test`), independent of nx registration.
`guard_audit_final.py` additionally enforces a COVERAGE COUNT: it asserts the harness emits one
marker for every declared criterion (55/55 verified — no phase silently dropped), refuses a
sub-floor criteria set, and requires `audit-final.9/.10` + `runtime-py.2`/`runtime-rs.2` to be
present AND PASS (all four verified PASS via uv/cargo). A narrowed glob can no longer read as
"built everything."

### F14 (ENV-PLAN-014) — cargo-registry-token blocker rewritten to reality
The round-1 claim that the token is consumed by "the environment-core-rs nx-release-publish
target defined in scaffold-workspace project.json" was FALSE (no `cargo publish` /
`CARGO_REGISTRY_TOKEN` / `uv publish` / `twine` anywhere; environment-core-rs has no
project.json). Rewrote the blocker's `description`, `how_to_provide`, `verification`, and
`note` to state plainly that the publish pipeline is UNIMPLEMENTED and this credential is
unenforced by any build/test/audit. Kept `blocks_at: release` (non-blocking) and
`required_by: [runtime-rs]` as the provenance anchor gap-check requires (non-empty, real node).

### Out-of-scope items discovered (NOT fixed this round — flagged)
- **Terminal DoD gate is non-functional (pre-existing).** `state-transition.js` refuses DONE
  unless every `[dod.N]` in README has an executed PASS, but `run-audit.js` never emits
  `[dod.N]` markers (criteria.json has zero `dod.*` ids; `audit-dod-mapping.js` is a
  comment-only stub). So the gate can never confirm. Independent of the phase-filter change
  (it fails identically under both semantics). Wiring `dod.*` criteria (or emitting mapped
  markers) is within `scripts/**` but outside the F8–F14 list — logged to BACKLOG.
- **`scripts/audit_checks.js`** still lists the old bare `python`/`cargo` reference commands.
  It is an authoring-time reference consumed by `compile-task.js`, not executed by the runtime
  harness (`criteria.json` is authoritative); left untouched to avoid scope creep.

---

The load-bearing signal that actually fixes F6 is `blocks_at`, not `required_by`:
the wave-2 halt came from `blocks_at: "per-state"` on a `needed` blocker whose
`required_by` named a wave-2 state. Rebinding `blocks_at: "per-state" → "release"`
defers enforcement to `nx release publish`, so the credential never halts any
build/test/audit wave, while `required_by: ["runtime-rs"]` is kept as the truthful
crate-ownership link and keeps the sweep's secret coverage satisfied (destination
`env:CARGO_REGISTRY_TOKEN`). This realizes the approved intent (do not gate wave 2;
publish-only) within the skill's invariants. `agent-mcp-deployment-secrets`
(ENV-PLAN-007) left untouched — it correctly blocks `refactor-agent-mcp`.
