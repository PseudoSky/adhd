# Orchestration ledger — agent-tool-registry

Driven by `workflow:plan-orchestrator` (execute mode) in worktree
`/Users/nix/dev/node/adhd-agent-registry` on branch `agent-registry-execution`.
`$SKILL` = installed cache `…/workflow/0.8.22/skills/plan-state-machine/scripts`.
Resumed from `agent-registry-schema/RESUME.md` (schema closed out, this is the next foundation plan).

## Preflight (2026-06-23)

| Check | Result |
|---|---|
| `compile-task --board` | 9-state **linear** chain (cost 9), no parallel waves, **no same-wave write-conflicts** |
| `gap-check` | **PASS** — 0 warnings |
| `env-pin-check --strict` | **all 9 guards pinned** (exit 0); npx `--yes` + repo python interpreter |
| `cross-plan-check docs/plan` | only cross-plan overlap touching this plan is `tsconfig.base.json` (every sibling + apigen) — **managed by worktree isolation**; concurrent apigen session is on `main` |
| human-blockers | **none** (`human-blockers.json` / `references.json` empty) |
| **F2 audit-phase membership** (RESUME open item 4) | **CLEAN** — `criteria.json`: foundation→scaffold.1-5, schema→4 schema states, **seed→seed-and-roundtrip.1-3 (correctly in `phase=seed`, NOT mis-filed into schema)**, audit→audit-schema/audit-final/code-review. No late criteria in an early phase. |

Verdict: **no plan-defect halt** — preflight green, proceeding to dispatch.

## Findings

- **F-TR1 (tiering, advisory):** all 9 states are `unrated` (no `model`/`effort`
  annotation), identical to the shipped `agent-registry-schema` sibling. Routing by
  the orchestrator table defaults (sonnet for TS/db states; opus for the code-review
  gate). Not a repair trigger — tiers advisory; schema sibling shipped unrated.
- **F-TR2 (telemetry):** executors in this corpus do not self-report token usage
  (RESUME gotcha) → `emit-state-metrics` degrades to `transcript_byte_proxy`. Rows
  marked `(byte-proxy)` until/unless an executor returns real MCP usage on `--complete`.
- **F-TR3 (script ergonomics):** `cross-plan-check.js` takes a **plans-root**, not a
  plan dir (errors `no plan-index.json` + exit 2 if given the plan dir). Run as
  `cross-plan-check.js docs/plan`. Minor; note for future preflights.
- **F-TR4 (misleading `--complete` audit — confirmed harmless):** `state-transition
  --complete` runs the declarative `run-audit.js`/`criteria.json` aggregate, which
  resolves criterion paths **relative to cwd** and carries a `foundation` phase the
  real harness lacks. On scaffold it reported `audit_exit:3, 2/5` (`.1/.2/.3` FAIL)
  while `.4` (`nx build`) PASS — logically impossible for a real deliverable. Root
  cause = cwd-fragile path resolution, NOT a bad deliverable. The **real** audit gate
  (`audit_tool_registry.py`, cwd-robust via `REPO_ROOT=__file__/../../../..`) passes
  scaffold-package.1-5 (verified from `/tmp`), and the audit STATES invoke the python
  harness, not `run-audit.js`. Matches RESUME's documented quirk. **Action:** trust
  the per-state guard + python `--phase` audit; ignore the `--complete` aggregate.
- **F-TR5 (telemetry):** scaffold executor did not pass `--input-tokens/--output-tokens/
  --tool-call-count` on `--complete` (transition log carries no token fields) →
  metrics fall back to `transcript_byte_proxy`. Row marked `(byte-proxy)`.

## Dispatch rows

| wave | slug | executor | tier | tokens(in/out) | guard-exit | retries | outcome | notes |
|---|---|---|---|---|---|---|---|---|
| 0 | scaffold-package | typescript-pro | sonnet | byte-proxy | build exit 0 | 0 | **ADVANCE** | commit `3a39b1c` (10 files, all under agent-tool-registry/ — **agent-mcp untouched**); real audit `scaffold-package.1-5` all PASS; reduction_ratio 0.962; `--complete` 2/5 aggregate = F-TR4 cwd artifact (harmless) |
| 1 | tool-and-type-schema | typescript-pro | sonnet | byte-proxy | guard exit 0 (13/13) | 0 | **ADVANCE** | commit `f7fec21` (10 files, agent-mcp untouched); real `--phase schema` audit scaffold.1-5 + tool-and-type-schema.1-3 all PASS; build exit 0; 3× reopen-persistence assertions. **Reservation breach (benign, F-TR6/7):** added `vite.config.ts`+`drizzle.config.js`+`project.json` test-target infra (out-of-reservation, package-local) |
| 2 | platform-and-binding-schema | typescript-pro | sonnet | byte-proxy | guard exit 0 (15/15) | 0 | **ADVANCE** | commit `6e7c077` (7 files, **all within reservation, agent-mcp untouched**); real `--phase schema` platform-and-binding-schema.1-3 all PASS; reopen + dod.1 negative-control. **dod.1 keystone `BindingStore.resolve` shipped.** No breach (heeded infra note) |
| 3 | mcp-server-schema | typescript-pro | sonnet | byte-proxy | guard exit 0 (12) | 0 | **ADVANCE** | commit `30cb357` (7 files, all within reservation, agent-mcp untouched); real `--phase schema` mcp-server-schema.1-2 PASS; 3 reopen JSON-round-trip tests. No breach |
| 4 | agent-tool-junction | typescript-pro | sonnet | byte-proxy | guard exit 0 (10) | 0 | **ADVANCE** | commit `d8d1833` (7 files, all within reservation, agent-mcp untouched); **full `--phase schema` audit 16/16 PASS**; reopen + permission-verbatim + no-cross-pkg-FK teeth tests. **dod.3 shipped.** No breach |

| 5 | audit-schema (GATE) | orchestrator-driven | — | n/a | **real guard `--phase schema` 16/16 PASS (exit 0)** | 0 | **ADVANCE** | end_ref `dfc70e8`. Gate verified green via authored python guard BEFORE completing. `--complete` aggregate `audit_pass:false (6/18)` = F-TR4 noise (fragile run-audit.js, counts unbuilt seed/dod + cwd-mis-resolved paths) — does NOT gate; state.json shows complete + advanced. Self-driven (nothing to author; reservation = audit script already present + passing) |
| 6 | seed-and-roundtrip | typescript-pro | sonnet | byte-proxy | guard exit 0 (7/7, cache-hit) | 0 (1 spurious re-start) | **ADVANCE** | commit `fa97fc8` (7 files, within reservation; schema/stores/agent-mcp untouched); idempotent (onConflictDoNothing) + reopen-resolve + negative-control teeth. **dod.2 proven.** F-TR10 double-start recovered via re-`--complete` |

### Findings (post-wave-6)

- **F-TR9 (cache external-dep gap):** `targetDefaults.test.inputs.externalDependencies`
  pins only `["vitest"]` → a `better-sqlite3`/`drizzle-orm` version bump does NOT
  invalidate this DB package's test cache. Recommend adding both. Tradeoff: diverges
  from main's value (merge cost). **Awaiting user decision.**
- **F-TR10 (executor double-start):** seed-roundtrip executor ran `--start` a SECOND
  time AFTER a clean start→work→commit(`fa97fc8`)→complete(`9c1f2b8`) cycle, re-opening
  the state to `in_progress` (git log: start→feat→complete→start). Recovered by
  re-running `state-transition --complete` (guard verified green 7/7 first) → advanced
  to code-review. Cause (unverified): executor likely re-ran `--start` after seeing the
  misleading `--complete` `audit_pass:false` aggregate (F-TR4). **Mitigation for future
  dispatches:** explicitly instruct executors to run `--start` exactly once and never
  re-start after `--complete`.

### dependsOn:[^build] audit (user-requested) — verified + hardened

- **Build already gets `^build` by default** for every project — via executor-keyed
  targetDefaults (`@nx/js:tsc`, `@nx/vite:build`, `@nx/rollup:rollup`). Verified by
  `nx show project` resolved output: all build targets = `dependsOn:['^build']`.
- **Custom generators preserve it (no override):** apigen plugin generator
  (`packages/apigen/nx/.../plugin/generator.ts`) emits `build` with only
  `executor:'@nx/vite:build'` + options, NO explicit `dependsOn` → inherits `^build`;
  only hardcodes `dependsOn` on `nx-release-publish`. `generate-lib.sh` uses stock
  `nx g @nx/js:library` (inherits) + patches `nx-release-publish`. Ideal design (single
  source of truth; auto-inherits default changes). NOT modified — they're correct.
- **Gap closed (F-TR11):** target-name `build` default lacked `dependsOn` → a build
  target on a NON-standard executor (e.g. `nx:run-commands`) would not inherit `^build`.
  Added `dependsOn:["^build"]` to the target-name `build` default → now executor-agnostic.
  Committed `869f845`. Re-verified all build targets still resolve to `['^build']`, build
  exit 0. Diverges from main's `build` default (`{inputs only}`) — additive, upstreamable.
- **test/typecheck:** still no `^build` (test by design — source-resolved repo, `^production`
  already invalidates; not needed). Left to user decision (see knobs).

### Cache invalidation verification (user-requested) — PROVEN

- **Own-source change → invalidates:** touched `schema.ts` → cache HIT→MISS→(revert)→HIT.
  Content-addressed; no stale false-green. (`default` input.)
- **Workspace packages/ dependency change → invalidates:** demo on real edge
  `data → transform`: touched `transform/src/index.ts` → `nx test data` HIT→MISS→
  (revert)→HIT. (`^production` input — drives the cache key; does NOT require
  `dependsOn:["^build"]`, which this source-resolved monorepo needs only for ordering/
  dist-consumption, not invalidation.)
- **Consumption model:** workspace deps resolve to SOURCE (`tsconfig` paths → src/index.ts),
  so `^production` is the correct invalidation input; no dist build needed.

### Cache verification (F-TR8) — user-requested, FIXED

- **Defect:** worktree `nx.json` (branched from main `34ed69a`, before the test-cache
  fix landed) had **no `targetDefaults.test`** → `nx test` NEVER cached. Proven: `build`
  re-run = cache hit; `test` re-run = recompute (~1.18s, no "read from cache").
- **Impact:** every per-`--complete` guard verification + every `audit-final` DoD check
  (~6 separate `nx test --testFile=…`) recomputed cold. Violates project "use the nx
  cache" standard.
- **Fix:** added `targetDefaults.test {cache:true, inputs:["default","^production",
  {externalDependencies:["vitest"]}]}` — **verbatim mirror of main's value** → merge-safe
  (converges, no conflict on the `test` key). Committed standalone `521b42d` (1 file).
- **Proof:** after `nx reset`, run 1 cold 4.91s → run 2 **cache hit 0.34s** (~14×);
  full `test` target also caches. Safe with exit-code gating (nx caches only exit-0 runs,
  so a teardown segfault → non-zero → not cached).

### Additional findings (post-wave-1)

- **F-TR6 (plan gap — scaffold omitted test-target infra):** `scaffold-package`'s
  delta-spec + reservations did NOT include the vitest test-target config
  (`vite.config.ts` + `@nx/vite:test` target in project.json), yet EVERY downstream
  guard uses `npx --yes nx test … --testFile=…` which under vitest 1.6.0 requires an
  explicit `@nx/vite:test` executor (plugin passthrough doesn't route `--testFile`).
  The wave-1 executor had to add it. **Now resolved in-package** (infra exists →
  subsequent states won't recur). **Cross-plan watch:** sibling registry plans
  (provider/policy/compiler/mcp-refactor/migration) scaffolded by the same
  "mirror agent-mcp" spec + same `--testFile` guards will likely hit this at their
  first test state — flag for their preflight. NOT dispatching plan-repair (one-time,
  self-healed, all gates green); logged for planner amendment.
- **F-TR7 (reservation breach — benign):** wave-1 commit `f7fec21` wrote 3 files
  outside its reservation (`project.json`, `drizzle.config.js`, `vite.config.ts`).
  All package-local, necessary to run the authored guard, agent-mcp boundary intact,
  build+audit green. Accepted. Orchestrator continues to hard-gate the agent-mcp
  boundary on every commit; package-local infra additions tolerated when green.
