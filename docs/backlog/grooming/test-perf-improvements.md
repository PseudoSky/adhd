# Test/build resource-consumption improvements — research + design

**Context.** Incident: `backlog-remediation` ran `npx nx affected -t test` (and
`verify-dist-load`) independently per package, across 14 concurrent git
worktrees under `.worktrees/burn-*`. System load average went ~115 → ~145,
swap hit 95% (18.5/19.5 GB), and 30 orphaned JVM processes were left behind
(BUG-006). The orchestration-level fix (serialize the heavy test gate onto one
agent instead of N concurrent worktrees) is already shipped in
`.claude/skills/backlog-remediation/remediation-pipeline.js`. This document is
the **test-mechanism-level** follow-on: how to make the underlying `nx test` /
`nx affected` / individual test suites themselves cheaper, so that even a
single worktree's gate run — and any future re-introduction of concurrency —
costs less CPU/RAM/wall-clock.

Sources read: `AGENTS.md` §7 ("Live testing is mandatory"), `nx.json`,
`packages/apigen/apigen-engine-conformance/project.json`,
`packages/apigen/java/project.json`,
`packages/apigen/apigen-engine-conformance/src/lib/gate.ts` (`runJavaMatrix`,
`resolveMvnForGate`), `packages/apigen/java/src/main/java/.../ApigenJavalinServer.java`,
`packages/apigen/apigen-plugin-java-javalin/src/lib/plugin.ts` (spawn/cleanup/
abort handling), `entrypoint/backlog/src/store/semantic-search.ts`,
`entrypoint/backlog/src/store/rag-e2e.spec.ts`, and the fastembed process host
at `~/.adhd/sox-ecosystem/.../embedding-provider/src/fastembedProcessHost.ts`
(published as `@adhd/sox-embedding-provider`, consumed by `entrypoint/backlog`
via `bootstrapSemanticBackend`), plus `.github/workflows/pull-request.yml`
(confirms CI already runs `nx affected -t test --parallel=5`).

## The live-testing policy, precisely

AGENTS.md §7 permits an env-gated skip **only** for a paid/external
third-party service (a real LLM, a billed API). It explicitly rejects "it's
slow," "it spawns child processes," "it needs a built CLI," and "it needs a
native module" as justifications — and `rag-e2e.spec.ts`'s own header cites
this almost verbatim to explain why it runs unflagged against the real
fastembed/ONNX stack. Any recommendation below that touches JVM spawning or
ONNX model loading has to either (a) act at a boundary the policy doesn't
cover (process-count/lifecycle, not fidelity), or (b) explicitly argue a
policy exception and say so, not quietly mock past it.

## The 10 recommendations, ranked by impact/effort

### 1. Fix JVM orphaning at the abort/signal boundary (root-cause BUG-006)
**What:** `java-javalin/plugin.ts`'s cleanup path only runs on `proc.on('exit')`
or an explicit `AbortSignal` the *caller* wires up. If the Node process
running the test (the vitest worker, or the `tsx gate.ts` process for
`runJavaMatrix`) is itself killed abruptly — SIGKILL from an OOM condition
under swap thrash, or a vitest worker pool teardown that doesn't propagate an
abort — the `java` child is never sent SIGTERM/SIGKILL and survives its
parent. This is exactly the 30-orphan symptom. Additionally, `runJavaMatrix`
in `gate.ts` uses `spawnSync(mvn, [...], { timeout: 120_000 })` for `mvn
... exec:java` — Node's `timeout` on `spawnSync` sends SIGTERM to the **mvn**
process, but `exec:java` forks the actual JVM as a *grandchild*; killing mvn
does not reliably kill that grandchild JVM, which is a second, independent
orphaning path from the one in `plugin.ts`.
**Where:** `packages/apigen/apigen-plugin-java-javalin/src/lib/plugin.ts` (add
`process.on('exit'|'SIGTERM'|'SIGINT')` handlers that call `proc.kill`
unconditionally, not only on caller-supplied `AbortSignal`); `packages/apigen/
apigen-engine-conformance/src/lib/gate.ts`'s `runJavaMatrix` (spawn mvn with
`detached: true` and kill the **process group** via `process.kill(-pid,
'SIGKILL')` on timeout/error, not just the mvn PID).
**Impact:** Directly eliminates BUG-006's 30 orphaned JVMs (each a full JVM
heap, commonly 200-500MB RSS idle) — this is the single highest-confidence
fix since it's the diagnosed root cause, not an estimate.
**Effort:** Low (process-group spawn options + signal handlers; ~30-60 lines).
**AGENTS.md conflict:** None — this is pure process-lifecycle hygiene, doesn't
touch what's being tested or fidelity.

### 2. Reuse one compiled JVM/mvn artifact across the whole gate run instead of per-vector-batch recompiles
**What:** `resolveMvnForGate` + `runJavaMatrix` runs `mvn compile exec:java`
fresh for the vectors file. Maven's own incremental compiler makes repeat
`compile` calls cheap *if* `target/classes` is warm, but `exec:java` still
pays full JVM cold-start (~1-2s) and Maven's plugin-resolution overhead
(~1-3s) **every call**. If `runConformanceMatrix` (the gate's caller) invokes
`runJavaMatrix` more than once per gate run (e.g. per test category), this
multiplies.
**Where:** `packages/apigen/apigen-engine-conformance/src/lib/gate.ts`
(`runJavaMatrix`, its single call site at line ~1004 in `runConformanceMatrix`).
**Impact:** Informed guess — need to confirm call count via `rg -n
"runJavaMatrix" gate.ts` call sites (currently 1 call site found, so likely
already single-shot; this is a **preventive** guard against future regression
more than an active problem today). If ever called N times: saves ~2-5s JVM
startup × (N-1).
**Effort:** Low (verify single-call-site invariant with a comment + a test
asserting `spawnSync` mock call count == 1, if a mock boundary is ever added
for this specific coarse invariant — see #4 for why that's compliant).
**AGENTS.md conflict:** None.

### 3. Bound and share ONNX model load across a single test *process*, not per describe/test invocation
**What:** `fastembedProcessHost.ts` already memoizes `_embedder` (skips
reload if `model === _currentModel && cacheDir === _currentCacheDir`), so
*within one host process* repeat inits are cheap. The actual cost is at the
next level up: each vitest **file** that imports `rag-e2e.spec.ts` gets its
own vitest worker, and each worker that calls `bootstrapSemanticBackend` forks
its own child process (`fork()` per `fastembedProcessHost` per README) which
loads a fresh ~600MB-1GB ONNX session — vitest's default `pool: 'threads'` (or
`forks'`) with multiple test files means N workers × N ONNX loads even inside
one worktree, before you multiply by worktree count.
**Where:** `entrypoint/backlog/vite.config.ts` (test pool config) +
`entrypoint/backlog/src/store/semantic-search.ts` (`bootstrapSemanticBackend`
call sites) + `rag-e2e.spec.ts`, `rag-optional-deps.spec.ts`.
**Fix:** Force vitest to run every spec file that calls
`bootstrapSemanticBackend` in a **single worker** (`test.pool = 'forks'`,
`poolOptions.forks.singleFork = true`, scoped via a `vitest.config.ts`
`include` override just for the RAG e2e specs, or a `vitest.workspace`
project split) so the ONNX model loads exactly once per `nx test` invocation
of that project, and reuse the same backend instance across the `describe`
blocks in that one process (the file already does per-test `tmp` stores but
could hoist `bootstrapSemanticBackend` to `beforeAll` instead of
`beforeEach`-shaped `openWithBackend()` calls per test — currently
`openWithBackend()` is called inside almost every `it()`, each triggering a
fresh child-process fork + full model init).
**Impact:** Measured-adjacent: the file's own header says "Model load is the
slow part (cold ONNX init)" with a 180s per-test timeout budget — if there are
~8-10 `it()` blocks each calling `openWithBackend()`, hoisting to one
`beforeAll` fork could cut this suite's wall-clock and peak RSS by roughly
(N-1)/N of the ONNX load cost, i.e. potentially 70-90% of this file's own
runtime, assuming cold init dominates (a few seconds to tens of seconds
depending on CoreML/cpu provider) over the actual embed calls. This is an
informed estimate, not measured — validate by timing `nx test
entrypoint-backlog` before/after.
**Effort:** Medium — requires restructuring `rag-e2e.spec.ts` to share a
backend across tests without cross-test state leakage (the file already
tracks this concern via `afterEach` calling `configureSemanticBackend(null)`;
sharing the backend while still resetting the *store* per test is the delta).
**AGENTS.md conflict:** None — no fidelity is reduced, this is purely
collapsing redundant real inits within one process into one real init.

### 4. Add a coarse "did we spawn N processes" invariant test, not a mock of the JVM/ONNX host itself
**What:** AGENTS.md forbids mocking the JVM or ONNX host to avoid running
them (that's the exact "it needs a native module" rationalization it calls
out). But a *process-count/lifecycle* assertion is a different boundary: a
test that spawns the real `java-javalin` plugin run, asserts exactly one
`java` PID exists via `ps`/`proc.pid` bookkeping during the run, and asserts
zero survive after `run()` resolves/rejects — this tests our own
cleanup code, not a stand-in for the JVM.
**Where:** New test in `packages/apigen/apigen-plugin-java-javalin/src/test/`
(e.g. `process-cleanup.spec.ts`) exercising the real `run()` with a
deliberately-aborted `AbortSignal` and a deliberately-killed parent, asserting
via `process.kill(pid, 0)` (throws ESRCH once dead) that the child is gone.
**Impact:** Prevents BUG-006-class regressions from recurring silently;
doesn't reduce current resource use by itself but is the regression guard for
fix #1. Low direct CPU/RAM impact, high leak-prevention value.
**Effort:** Low-medium (needs a real spawn + real kill-race test, per AGENTS.md
§7.2 "assertions must have teeth" — prove it fails without fix #1 by
reverting the signal handler and confirming a lingering PID).
**AGENTS.md conflict:** None — explicitly compliant by construction (real JVM,
real signal, only counting processes not faking behavior).

### 5. Nx: enable `test` target output caching keyed correctly for the Java/JVM and conformance targets
**What:** `nx.json`'s `targetDefaults.test` already has `cache: true` with
`externalDependencies: ["vitest","better-sqlite3","drizzle-orm"]`, so this
already works for the generic `test` target. But
`apigen-engine-conformance`'s `conformance` target (the `tsx gate.ts`
invocation that calls `runJavaMatrix`) is a plain `nx:run-commands` with **no
`cache` key set at all** and **no declared `inputs`/`outputs`** — every
invocation re-runs the full matrix including the JVM subprocess, even when
nothing under `packages/apigen/**` changed since the last green run.
Similarly `apigen-java`'s `test` target (mvn/surefire) *does* have
`cache: true` with explicit inputs/outputs, which is correct — the gap is
specifically the `conformance` target.
**Where:** `packages/apigen/apigen-engine-conformance/project.json`
(`targets.conformance` — add `"cache": true`, `"inputs": ["default",
"^production", "{workspaceRoot}/packages/apigen/java/src/**/*"]`, and an
`"outputs"` pointing at whatever gate.ts writes, if anything durable; if it's
side-effect-only, at minimum caching the pass/fail via a marker file written
by the command).
**Impact:** Informed estimate: this target pays a full JVM+mvn compile+exec
cycle (several seconds minimum, per §1's cold-start numbers) on **every** run
regardless of change, including re-runs the remediation pipeline does per
worktree per package. Caching this would make no-change re-runs near-instant
(Nx cache restore, milliseconds) instead of paying the JVM cost again. This
was directly implicated in the incident: 14 worktrees re-running unchanged
packages' full gates.
**Effort:** Low (project.json edit) but requires care that `gate.ts`'s actual
side effects (does it write a report file? exit code only?) are captured in
`outputs` or the cache will report false positives on a truly side-effect-only
command — verify by reading `gate.ts`'s tail (write path) before landing.
**AGENTS.md conflict:** None — caching an unchanged-input re-run doesn't skip
the test when it matters, only when Nx's hash proves nothing relevant changed
(same guarantee already extended to every other cached target in the repo).

### 6. `nx affected` scoping: verify the remediation pipeline computes affected against the correct base, not `HEAD~N` or full repo
**What:** Not directly read in this pass (pipeline script wasn't in the file
list provided), but the incident description says "full `npx nx affected -t
test`... independently per package" — if "per package" means the pipeline
looped over packages and ran `nx affected -t test --projects=<pkg>` (or
equivalent) rather than a single `nx affected -t test` for the whole affected
set, that's N redundant dependency-graph computations and N separate Nx
daemon round-trips instead of one batched run that Nx's own task orchestrator
parallelizes and dedupes internally.
**Where:** `.claude/skills/backlog-remediation/remediation-pipeline.js` (already
serialized per the incident fix, but worth confirming the *invocation shape*
was also collapsed to one `nx affected -t test` call for the whole batch,
not N sequential per-package invocations of the same command).
**Impact:** Informed guess — collapsing N separate `nx affected` invocations
into 1 avoids N-1 redundant project-graph reconstructions (each a few hundred
ms to ~1-2s depending on repo size) and lets Nx's own scheduler batch
independent leaf tasks. Moderate wall-clock win, does not by itself fix
memory pressure (that's #7-#10).
**Effort:** Low (verify + adjust invocation in the already-touched pipeline
script).
**AGENTS.md conflict:** None.

### 7. Cap `--parallel` and use `NX_DAEMON` process-pool limits proportional to available RAM, not CPU count
**What:** CI's own `pull-request.yml` uses `--parallel=5` for `nx affected -t
test`, which is reasonable on a CI runner sized for that concurrency. Nx's
default `parallel` (3) and any higher override are chosen based on CPU count
by convention, but the actual constraint in this incident was **swap/RAM**
(95% of 19.5GB), not CPU — 5 concurrent heavy test tasks (each potentially
spinning up a JVM and/or an ONNX host at 200MB-1GB RSS) can saturate RAM long
before CPU. Nx has no native "memory-aware" scheduling; the safe fix is to
explicitly cap `--parallel` lower for **local/worktree** runs specifically
(as opposed to CI's dedicated runner), e.g. `--parallel=2` or `--parallel=1`
when running inside `.worktrees/`, and to route the JVM/ONNX-heavy targets
(`apigen-engine-conformance:conformance`, `apigen-java:test`,
`entrypoint-backlog:test`) through a dedicated low-concurrency lane rather
than mixing them into the same `--parallel=5` batch as cheap unit tests.
**Where:** `.claude/skills/backlog-remediation/remediation-pipeline.js` (the
`--parallel` flag it passes) and, if a durable workspace-wide default is
wanted, `nx.json`'s `targetDefaults` doesn't support per-target parallelism
caps directly — Nx's `--parallel` is a CLI/run-level flag — so this has to
live in the pipeline script or a wrapper, not `nx.json`.
**Impact:** Directly addresses the measured symptom (swap 95%, load avg
+30) — this is the most load-bearing lever available for the observed
incident, but the "right" number (1 vs 2 vs 3) is a guess without a memory
budget model; recommend instrumenting one run with `/usr/bin/time -l` (macOS)
or `ps`-sampling around the heavy targets to get real peak-RSS-per-target
numbers before picking a final cap.
**Effort:** Low (flag change) to Medium (if building actual memory-aware
scheduling/backpressure).
**AGENTS.md conflict:** None — orchestration-level, doesn't change what runs.

### 8. Separate a "heavy/live" test tier from the default `nx affected -t test` sweep, with its own concurrency=1 target
**What:** Introduce a `test-heavy` (or similarly named) Nx target — distinct
from `test` — for suites that are known to spawn a real JVM or fork a real
ONNX host (`rag-e2e.spec.ts`, the java conformance path). Keep them running
by default (AGENTS.md requires this — no silent gating), but give the
orchestrator/remediation pipeline a way to schedule that specific tag/target
with `--parallel=1` globally across the whole batch (not per-worktree),
while ordinary fast unit tests keep running at higher concurrency. This is
orthogonal to AGENTS.md's live-testing mandate: the tests still run,
unflagged, every time — only the *scheduling lane* changes.
**Where:** New `project.json` target on `apigen-engine-conformance` (wraps
`conformance`) and `entrypoint-backlog` (wraps the RAG e2e file specifically,
e.g. via a vitest `--project` split so `test` stays fast and a `test:rag-e2e`
target isolates the heavy file) + a small Nx `runManyOptions`/CLI convention
documented in the remediation pipeline to run `heavy`-tagged targets with
`--parallel=1` regardless of the rest of the batch's concurrency.
**Impact:** Informed guess: this is what actually prevents "14 worktrees × 5
parallel × 1 JVM/ONNX each" from ever recurring, by construction rather than
by an easy-to-forget flag choice at call time. This is the structural version
of #7.
**Effort:** Medium (target + tagging + pipeline convention + docs).
**AGENTS.md conflict:** None — explicitly designed to keep every live test
running by default; it only changes *when/how many at once*, never *whether*.

### 9. Warm the fastembed model cache once per machine, not per worktree checkout
**What:** `fastembedProcessHost.ts` reads/writes `cacheDir` (backlog config
resolves to `~/.cache/sox/models`, per `rag-e2e.spec.ts`'s doc comment) —
this is already a **shared, machine-global** path, not per-worktree, so the
~600MB-1GB model *download* itself is not re-fetched per worktree today
(good). The remaining per-worktree cost is the **process fork + ONNX session
init** (CPU/RAM to load the cached weights into a running inference session),
which cannot be shared across OS processes for the documented native-safety
reasons in the file's own header (cross-isolate/native-timing hazards
explicitly rule out sharing one host process across concurrent callers).
**Where:** No code change recommended here — this is a "confirm and
document" item: verify via `ls -la ~/.cache/sox/models` that all worktrees
truly share one cache dir (they should, since it's keyed off `$HOME`, not
`$PWD`), and add a comment/backlog note if any worktree-local override ever
creeps in (e.g. via an `.env` per worktree pointing `cacheDir` at a
worktree-relative tmp path — check `entrypoint/backlog/src/env.ts` for how
`cacheDir` is resolved).
**Impact:** Low direct impact (the expensive part — disk I/O for the
600MB-1GB download — is likely already shared); this item exists mainly to
close the loop and prevent a future regression where someone "fixes" cache
isolation per-worktree for hygiene reasons and reintroduces N-way redundant
downloads.
**Effort:** Low (verification + a guard test asserting `cacheDir` resolves
to `$HOME`-relative, not `cwd`-relative).
**AGENTS.md conflict:** None.

### 10. Nx daemon + `sync-deps`/`lint` dependency chain: avoid redundant `lint`+`sync-deps` runs feeding into every `test` across 14 worktrees
**What:** `nx.json`'s `targetDefaults.test.dependsOn = ["lint", "^build"]`
and `targetDefaults.lint.dependsOn = ["sync-deps"]`. Each worktree has its
own `.nx` cache directory (worktrees don't share Nx's local cache the way a
single checkout would across sequential runs, though they *can* share a
**remote** cache if one is configured — not confirmed present here), so `lint`
+ `sync-deps` are being fully recomputed and re-cached independently in each
of the 14 worktrees rather than reusing one shared cache entry for identical
inputs (same source, since these are all branches off the same base commit
set for a remediation sweep).
**Where:** `nx.json` (no remote cache config found in this pass — worth
confirming `nxCloudId`/`tasksRunnerOptions` are absent, i.e. Nx Cloud/remote
caching is not currently wired) + the remediation pipeline's worktree
provisioning step.
**Impact:** Informed guess, largest potential lever if unconfirmed: if 14
worktrees are paying full `lint`+`sync-deps`+`build` costs independently
because there's no shared remote cache, wiring one (even a simple self-hosted
Nx cache server, or `NX_CACHE_DIRECTORY` pointed at a location shared across
worktrees via a bind mount) could turn 13 of 14 worktrees' `lint`/`build`
steps into cache hits instead of full recomputation — potentially the single
biggest CPU-time reduction on this list, but effort and payoff both scale
with how much the worktrees' inputs actually overlap (a remediation sweep
touching different files per worktree reduces the hit rate).
**Effort:** Medium-high (needs a shared cache backend decision: Nx Cloud
account, self-hosted, or a shared local dir with correct locking across
concurrent worktree writers — the last of these needs verifying Nx's local
cache is safe for concurrent multi-process writers, which is consistent with
this repo's ADR-0012 parallel-process-enabled invariant but should be proven,
not assumed).
**Effort:** Medium-high.
**AGENTS.md conflict:** None — caching, not skipping.

## Ranked by (impact / effort)

1. **#1** JVM orphan fix at the signal/process-group boundary — high impact
   (directly kills the diagnosed BUG-006), low effort.
2. **#7** Cap `--parallel` / isolate heavy targets to low concurrency for
   worktree-driven runs — high impact on the measured swap/load symptom, low
   effort.
3. **#5** Cache the `conformance` target properly — likely high impact for
   repeated/unchanged re-runs (exactly the incident's shape), low effort.
4. **#3** Hoist ONNX backend init to one `beforeAll` per test file/process —
   potentially large wall-clock/RAM win for the RAG e2e suite specifically,
   medium effort.
5. **#4** Process-lifecycle regression test for #1 — low direct impact, low
   effort, protects the #1 fix long-term.
6. **#8** Structural heavy/light test-tier split — durable prevention of
   recurrence, medium effort.
7. **#6** Confirm/collapse `nx affected` invocation shape in the pipeline —
   moderate impact, low effort (mostly verification).
8. **#2** Guard against redundant JVM recompiles in `runJavaMatrix` — low
   current impact (already single-call-site), low effort, preventive.
9. **#9** Confirm shared model cache across worktrees — low impact (likely
   already correct), low effort, preventive/documentation.
10. **#10** Shared remote Nx cache across worktrees — potentially the largest
    single number on this list, but highest effort and least certain payoff
    without first measuring cross-worktree cache-hit rate; sequence last
    pending that measurement.

## What would need to be measured before committing to a memory-budget number

None of the RSS/wall-clock figures above beyond the BUG-006 orphan count are
directly measured in this session — they're informed estimates from reading
the JVM/ONNX code paths and the AGENTS.md-cited "180s cold ONNX init" budget
comment. Before finalizing a `--parallel` cap (#7) or a cache-hit-rate
projection (#10), run one instrumented pass (`/usr/bin/time -l` per heavy
target, or `ps -o rss` sampling during a real `nx affected -t test` on a
single worktree) to replace these estimates with real numbers.
