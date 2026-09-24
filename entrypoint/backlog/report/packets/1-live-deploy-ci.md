# Packets — Domain 1: Live / Deploy / CI / Docs

**Author:** architect (packet-authoring pass), 2026-09-22.
**Base branch:** `feat/backlog-hard-replacement` (worktree `.worktrees/backlog-v2`), the PR #9 cutover candidate (643/643 green, MERGEABLE).
**Live build today:** `.worktrees/restore-min` (branch `fix/live-restore`) — a temporary hand-port, **not** `main`.
**Frozen rollback build:** `.worktrees/backlog-cutover` @ `ab262d8f` (dist 2026-09-21 23:19).

## Shared invariants every packet obeys

- **ADR catalog:** the `adhd` repo has **no** `docs/decisions/`. The governing catalog is
  `/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (0001–0020). Load-bearing here: **ADR-0013**
  (feature switches are typed config, **never** env vars), **ADR-0012** (parallel-process enabled —
  never reason from single-writer), **ADR-0004** (data-root placement), **ADR-0002** (install model),
  **ADR-0014** (snapshot retention report-first), **ADR-0015** (PROPOSED, never accepted — do not adopt),
  **ADR-0020** (embedding funnel is peer-spawned + self-reaping — **never** call it a "daemon").
- **Live-testing policy (AGENTS.md §7):** behavioural tests run by default, unflagged. An env-gate is
  legitimate **only** for a paid/external third-party service, documented in README + AGENTS.md + the
  test header with a **named owner**. "Needs CUDA", "spawns a process", "slow" are **not** grounds.
- **Never `--skip-nx-cache`.** Never `tsc` directly. pnpm only. No destructive git. Worktrees under
  `.worktrees/`. Ephemeral artifacts under `tmp/` / `.adhd/tmp/`.
- **No gate bypass:** do not use `--no-verify`; do not `git reset --hard`/`git clean -f`/`git stash`.
- **Coordinated, disjoint:** `LIVE-9` is reserved for the version/health pair (`2039bb80`+`87799e1d`)
  and **must stay disjoint from the embedding-domain architect's packets** (the embedding funnel,
  provider, and pool items). Do not fold embedding-provider changes into any packet below.

---

## PACKET LIVE-1: Re-cutover — retire the hand-port, deploy the branch build, keep rollback

- **Goal:** Production runs the `feat/backlog-hard-replacement` build (via PR #9 on `main`) instead of
  the disposable `restore-min` worktree, with a proven one-command rollback to the frozen build.
- **Scope:** the deploy sequence + rollback doc only. Non-goals: the bin/MCP re-pointing (LIVE-2), the
  actual `@adhd/backlog` npm publish (human-gated, LIVE-2 P5), and any source fix on the branch.
- **Inputs:** `42fc1822` (31-commit staleness), `46d04e3f` (latency — fixed live only), the PR #9 merge
  → re-cutover sequence, `entrypoint/backlog/report/cli-deployment-separation-spec.md` §3/§7,
  `entrypoint/backlog/report/cutover-execution-plan.md` §D/§E. Current state: live = `restore-min`
  hand-port (branch `fix/live-restore`), which itself dropped the 5 upstream doc updates (`d80d344e`);
  `main` @ `29da1926` carries PRs #10–12 but **not** the branch; `main`'s `entrypoint/backlog` is the
  **v1-generation** build (six-verb/`humanId` surface) — so "merge to main" alone does **not** deploy
  the branch's behaviour until the build is re-cut.
- **Acceptance/DoD:**
  1. `main` contains the branch (`git merge-base --is-ancestor <branch-head> main`), PR #9 merged.
  2. The live bin resolves to a build built from the merged `main` commit — `git -C <build-tree> rev-parse HEAD`
     equals the deployed dist's recorded source sha (or the release manifest's), **not** `restore-min`'s.
  3. Latency regression gone live: `time adhd-backlog backlog query --input '{"limit":1}'` ≤ 2 s
     (branch measured 0.99/1.16 s vs frozen 12.18/13.94/78.94 s).
  4. Rollback rehearsed and recorded: re-point to `.worktrees/backlog-cutover`/frozen release and
     confirm a `query` answers within the frozen baseline.
  - **Negative control:** re-point the bin at the frozen build and confirm (3) goes **red** (≥12 s) —
    proves the latency assertion actually detects the pre-fix build.
- **Tests:** a `deploy-verify` shell check committed under `entrypoint/backlog/report/` (or `tmp/`-run)
  that asserts (2)+(3)+(4) and exits nonzero on failure; run it post-cutover and record output in the
  packet's completion note. No gating flag.
- **Dependencies:** LIVE-2 should land first or together (re-cutover is the moment to stop pointing at
  a worktree at all). External blockers: **human approval to merge PR #9** and **human approval to
  publish `@adhd/backlog`** (both explicitly excluded from the 2026-09-22 autonomy grant).
- **Size/tier:** M · executor hint: `backend` (deploy/ops), with a `test` verification pass.
- **Risks/unknowns:** whether the `restore-min` hand-port's fixes (`42fc1822`'s `7875d848`/`d4a72009`/
  `a8906d3d` + dep bumps) are all present on the branch — verify per-commit, do not assume. Spike if
  the branch does not typecheck against its own lockfile (`0c800822` records the frozen commit does not).
- **Decision gates:** **Human** — approve PR #9 merge + publish. Recommendation: merge then deploy as
  one cutover window; do **not** patch the frozen release in place.

---

## PACKET LIVE-2: De-worktree production — canonical `adhd-backlog` bin + `releases/current` + MCP re-point

- **Goal:** No live consumer (bin or MCP) resolves into a git worktree; the canonical `adhd-backlog`
  name exists, the ambiguous bare `backlog` is gone, and opencode has a working backlog MCP server.
- **Scope:** machine-global wiring (bin shim, `~/.adhd/backlog/releases/<v>/` + `current`, `~/.claude.json`,
  `.mcp.json`, `~/.config/opencode/opencode.json`) + the in-repo guard. Non-goals: publishing to npm
  (LIVE-1 P5), the skill contents (LIVE-8), sync-global internals (LIVE-3).
- **Inputs:** `e7f6f9e7` (three seams hardcode `.worktrees/backlog-cutover`), `7a38eb0a` (two MCP servers
  named `backlog`, different builds), `5d82f767` (stale pnpm-global pointer), spec
  `cli-deployment-separation-spec.md` §1 (target topology) + §4 Phase 0.1–0.3. Current state: live is
  `.worktrees/restore-min` — the **same fragility class**, now in a second worktree.
- **Acceptance/DoD (spec §6 checks 1–3, 10–11):**
  1. `command -v adhd-backlog` prints a path; `command -v backlog` prints nothing.
  2. `head -20 "$(command -v adhd-backlog)" | grep -c .worktrees/` → `0`.
  3. `rg -n '\.worktrees/backlog' ~/.claude.json .mcp.json ~/.config/opencode/opencode.json ~/Library/pnpm/adhd-backlog` → **no matches**.
  4. `~/.config/opencode/opencode.json` has an `mcp.backlog` entry; a `mcp__backlog__*` call from each
     host returns production items.
  5. An in-repo check asserts the live `adhd-backlog` resolves **outside** `.worktrees/`.
  - **Negative control:** delete the `adhd-backlog` shim → the check in (5) goes **red**; restore it → green.
- **Tests:** the spec §6 runbook (read-only) as a committed script; (5) as a red→green spec in the
  owning tooling package. Back up each edited global file before the single-line edit; rename (never
  delete) the old `backlog` shim.
- **Dependencies:** bytes must already be staged at `~/.adhd/backlog/releases/<v>/` (spec §3 steps 1–4)
  — do this from the **merged** build (LIVE-1), not `restore-min`. External blocker: **human approval**
  for machine-global install/relink.
- **Size/tier:** M · executor hint: `backend` (ops), `test` for the runbook.
- **Risks/unknowns:** `.mcp.json` is a **tracked** file — its re-point is a repo commit; keep it a
  single line and land via the normal hook. Spike if a consumer still expects the bare `backlog` name.
- **Decision gates:** **Human** — approve the global bin/MCP edits. Recommendation: quarantine
  (rename) the bare `backlog` shim rather than delete; keep the last N `releases/` for rollback.

---

## PACKET LIVE-3: sync-global — see the real shim, stop reporting false `verified=true`

- **Goal:** `release:sync-global` either actually updates the global CLI or reports honestly; it can
  never again print the published version with `verified=true` while the install is old.
- **Scope:** `tools/nx-plugins/build/executors/sync-global/sync-global.mjs` (+ its `releases/current`
  awareness). Non-goals: the publish pipeline (LIVE-4), the bin itself (LIVE-2).
- **Inputs:** `bea4bfe1` (CRITICAL — false `verified=true`, observed live), `f1dece41` (bin-name keying
  blind spot: `sync-global.mjs:233-235,584` key off the declared `bin` name, so the live `backlog`
  shim is invisible), spec §P1. Current state: `:233-235`/`:584` confirmed reading `pkg.bin` keys.
- **Acceptance/DoD:**
  1. With a global install deliberately left at an old version, `sync-global` **fails** (nonzero exit)
     or prints `verified=false` — never `unchanged verified=true`.
  2. The live `backlog`/`adhd-backlog` shim is detected and repaired (or reported stale) even when its
     name does not equal the declared bin key.
  3. A `current`-symlink shim is not clobbered by a future `pnpm add -g` (layout awareness).
  - **Negative control:** reproduce `bea4bfe1` first (old install + published newer version → current
    code prints `verified=true`) so the new assertion has a red state to prove it kills.
- **Tests:** a `*.spec.mjs` for `sync-global.mjs` (none exists today) driving a temp `pnpmGlobalBinDir`
  with a stale shim + stale store `package.json`, asserting the two failure modes go red then green.
  Runs under the build-tools test target, default-on.
- **Dependencies:** none beyond LIVE-2's name decision (`adhd-backlog`). Item `3c504ca0` (ranges fixed
  but never committed) touches the same directory — sequence LIVE-11 after this to avoid a file-lock.
- **Size/tier:** M · executor hint: `backend` or `debug` (tooling), `test` for the spec.
- **Risks/unknowns:** `releases/current` handling is design-unsettled until LIVE-2 chooses the layout;
  if LIVE-2 slips, scope LIVE-3 to the honesty fix only. Spike if `pnpm` global-store layout differs
  from the assumed `~/Library/pnpm/global/5`.
- **Decision gates:** none (given LIVE-2's bin name). Recommendation: keep the honesty fix independent
  of the layout change so it can land first.

---

## PACKET LIVE-4: Publish-gate integrity — clean-room smoke, registry restore, clean-worktree release

- **Goal:** The publish precondition passes on a clean tree and ships the exact bytes it verified.
- **Scope:** `scripts/acceptance/clean-room-smoke.sh` (sox-ecosystem), `scripts/build-index.ts`
  (sox-ecosystem), `tools/nx-plugins/build/executors/publish/release-publish.mjs`,
  `tools/nx-plugins/build/executors/version/impl.js`, `tools/nx-plugins/build/executors/verify/`.
  Non-goals: the release _content_; the `assets` cache fix (LIVE-5).
- **Inputs:** `ddaf7a82` (`--skip-nx-cache` + unscoped `run-many -t build` at `clean-room-smoke.sh:69,77`),
  `fa894329` (script rewrites `registry/index.json`, never restores → `build-index` refuses dirty tree),
  `c582e60d` (release cannot run from a clean worktree — `build-index.ts` resolves the **primary** root),
  `0a6c9618` (`release-publish.mjs` zero coverage + false header claim), `7fc1a410` (per-package
  changelog spawn not batchable — documented as a non-goal, not to be forced), `8a381756`
  (`verify-dist-load` stays subprocess-isolated — **do not** convert to in-process).
- **Acceptance/DoD:**
  1. `clean-room-smoke.sh` contains no `--skip-nx-cache` and no unscoped `run-many -t build`.
  2. After `clean-room-smoke.sh` exits 0, `git status --porcelain` shows **no** `registry/index.json`
     change (the script restores it in a `finally`/`trap`).
  3. `pnpm run release:prepared` completes from a **clean linked worktree** (or `build-index` gains an
     explicit `--root`), without touching the primary tree's uncommitted files.
  4. `release-publish.mjs`'s header no longer asserts a nonexistent spec; either the negative-control
     spec exists or the file + its doc references are removed.
  - **Negative control:** run `clean-room-smoke.sh` on a clean tree; confirm (2) fails **before** the
    fix (dirty `registry/index.json`) and passes after. For (1), `rg -- '--skip-nx-cache' clean-room-smoke.sh`
    must be empty (a grep with teeth, not a proxy).
- **Tests:** a shell-level assertion test for the smoke script's tree-restore, plus a unit spec for
  `build-index --root` / worktree mode. `8a381756` and `7fc1a410` are documented non-goals: add a
  comment/test asserting the current isolation and non-batching are intentional so a future pass does
  not "fix" them.
- **Dependencies:** LIVE-1 for the release window. `fa894329`/`ddaf7a82` are **sox-ecosystem** files —
  cross-repo; coordinate owner. `3c504ca0` shares the `build` directory (sequence after).
- **Size/tier:** L · executor hint: `backend`/`refactor` (build tooling), `test`.
- **Risks/unknowns:** whether `build-index.ts` can accept a worktree-local root without violating the
  no-`file://`-sources invariant — spike if the portable-index assertion cannot hold from a worktree.
- **Decision gates:** none. Recommendation: fix the smoke script's two bans + the restore trap first
  (small, high-leverage); treat worktree-release as a follow-up.

---

## PACKET LIVE-5: Exec-bit + assets cache-restore integrity

- **Goal:** A build cache hit can never ship a non-executable bin, and `build.options.assets` can never
  silently no-op on a vite-built package.
- **Scope:** `tools/nx-plugins/assets/executors/copy/impl.js` (the chmod), `entrypoint/backlog/project.json`
  `build` target, the inferred `assets` target's `outputs` in `tools/nx-plugins/assets/plugin.js`.
  Non-goals: the publish gate (LIVE-4).
- **Inputs:** `f59fab33` (HIGH — live recurrence of `97418aa1`: build cache hit restored
  `dist/index.js` at mode 644, breaking the `adhd-backlog` symlink), `efebbd9e` (`build.options.assets`
  is a silent no-op for **all** `@nx/vite:build` packages), `97418aa1` (resolved — the chmod lives
  outside the target that owns the bin), `BUG-026` (the assets `outputs` must never claim the shared
  `dist/` dir — already fixed in `entrypoint/backlog/project.json:94`).
- **Acceptance/DoD:**
  1. After `npx nx build backlog` from a warm cache, `stat -f '%Lp' entrypoint/backlog/dist/index.js`
     is `755`; `adhd-backlog --help` exits 0.
  2. The chmod is owned by the target that owns the bin (a `build` poststep or a dedicated target keyed
     on the bin path) — not by `assets`.
  3. A vite-built package that declares `build.options.assets` either ships the asset or fails loudly;
     `efebbd9e`'s audit list (backlog `skill/`, python-env `apigen_python/`) is verified shipped.
  - **Negative control:** warm-cache build, then `chmod 644 dist/index.js`, restore from cache again,
    and assert the mode is `755` **after** the fix — this fails on current code.
- **Tests:** a spec asserting the post-build mode for `entrypoint/backlog` (subprocess `stat`), plus a
  spec asserting the assets `outputs` never include the bare `dist` directory (extend
  `tools/nx-plugins/build/bug-026-assets-output-scope.spec.mjs`). Default-on.
- **Dependencies:** none. Overlaps `97418aa1` (resolved) — do not re-open it; this is the build-target
  recurrence it explicitly left open.
- **Size/tier:** S–M · executor hint: `backend`/`refactor`, `test`.
- **Risks/unknowns:** whether nx can restore a file mode at all (a cache archive may not carry the
  exec bit) — spike if the fix must be a post-restore chmod in the build target rather than an output
  declaration.
- **Decision gates:** none.

---

## PACKET LIVE-6: CI unblock — format:check, real-model tests, affected-set blind spot

- **Goal:** CI is green and, more importantly, is _evidence_ — its green means the affected tests ran.
- **Scope:** `.github/workflows/ci.yml`, `.github/workflows/pull-request.yml`, `.prettierrc`/
  `.prettierignore`, the real-model spec files, `tools/nx-plugins/lib/metrics.js`. Non-goals: fixing
  the code under test; the packed-consumer harness (LIVE-7).
- **Inputs:** `81fbebc1` (`ci.yml:53` `nx format:check` fails first, masking the affected step; root
  cause is `.prettierrc` `printWidth` 80 vs ~100-col code + `pnpm-lock.yaml` not ignored),
  `bb38c9f4` (PR `test` job red — real-fastembed/ONNX needs CUDA absent on the runner; **a disable is
  in flight**), `81de39f7` (`ci.yml:54` affected set excluded `backlog:test` for a push),
  `47d0f713` (DeepSource JS red on `main`, pre-existing analyzer-gate failure), `f96e796e`
  (`checkCpuGuard` false-positive on `backlog:chmod-bin` under real `nx affected -t test`).
- **Acceptance/DoD:**
  1. `npx nx format:check` passes on `main` and on the branch.
  2. The CI affected step actually runs `backlog:test` for a push touching `entrypoint/backlog` — the
     run log shows the task (proves `81de39f7`).
  3. The real-model tests either **run green** in CI (preferred, per §7) or are gated exactly as §7
     permits — and if gated, the approval is in README + AGENTS.md + the test header with a named owner.
  4. `checkCpuGuard` does not trip on `backlog:chmod-bin` during a real affected run.
  - **Negative control:** push a one-line `entrypoint/backlog` change; the CI run log must show
    `backlog:test` executed (fails on current CI). For the CPU guard, re-run the failing command and
    assert it completes without `ADHD_NX_METRICS_MAX_CPU_PCT` overrides.
- **Tests:** CI itself is the test; add a workflow-level assertion (grep the run log for the task, keyed
  on exit code, not a `| grep -q passed`). The real-model suite keeps its current spec files.
- **Dependencies:** none.
- **Size/tier:** M · executor hint: `backend`/`test`.
- **Risks/unknowns:** the **CUDA disable conflicts with §7** — a local fastembed/ONNX model is neither
  paid nor external, so §7 does **not** sanction gating it. The compliant fix is to make the runner
  load a CPU execution provider (or provision the libs), not to skip. If a genuine external/paid
  dependency is proven, follow the §7 documentation trio.
- **Decision gates:** **Repo owner** — (a) `.prettierrc` decision: add `printWidth: 100` **or** ignore
  generated artifacts (`pnpm-lock.yaml`) + one-shot `format:write`. Recommendation: **both** —
  `printWidth: 100` + `.prettierignore` entries for `pnpm-lock.yaml` and generated output; do **not**
  commit a 17,908-line lock rewrite. (b) **CUDA:** recommendation — **provision CPU EP, do not disable**
  (per §7); only if the owner rules it a paid/external service does the documented gate apply.
  (c) DeepSource: recommendation — fix the three top-level `return`s in `.claude/**` scripts at source;
  do **not** game `.deepsource.toml`.

---

## PACKET LIVE-7: Clean-room functional consumer e2e (packed-consumer-smoke)

- **Goal:** A published tarball can no longer ship functionally broken — every publishable package is
  installed from its packed tarball into an ephemeral project and driven through a real subcommand.
- **Scope:** a new shared harness (owner: `tools/nx-plugins/build/executors/smoke-test/` or a `tmp/`-run
  runner) + per-package functional smoke specs. Non-goals: the liveness-only `clean-room-smoke.mjs`
  (LIVE-4 keeps it).
- **Inputs:** `fc06435f` (the root-cause gap behind BUG-012/013/014/015 — no gate installs the published
  artifact and drives real functionality; `verify-dist-load` is existence-only, `publish-hygiene` is
  file-list-only, `nx test` resolves to source). Current state verified in the item body.
- **Acceptance/DoD:**
  1. `npm pack` each target package's built dist → install the tarball into an ephemeral external
     project → run a real subcommand (e.g. `adhd-backlog backlog query --input '{"limit":1}'`) and
     assert the consumer-visible result, keyed on exit code.
  2. Runs **pre-publish** as a publish dependency, offline, deterministic (no propagation lag).
  3. Covers at minimum `backlog`, `apigen-cli`, and one `py-*` host; extends to `agent-*`/`dispatch-*`.
  - **Negative control:** deliberately break a `../` hop (or the skill asset path) in a package's built
    dist, pack it, and confirm the harness goes **red** — the exact failure BUG-012/013 shipped past CI.
- **Tests:** the harness **is** the test; wire it as a `dependsOn` of `nx-release-publish` and into the
  PR `test` job. Default-on, no flag.
- **Dependencies:** LIVE-5 (the backlog `skill/` asset must actually ship) and LIVE-2 (the bin name must
  be settled) for the `backlog` case.
- **Size/tier:** L · executor hint: `test` (harness) + `backend`.
- **Risks/unknowns:** the py-hosts need `python3` in CI — per §7 that is **setup**, so make it a hard
  failure when missing, never a silent skip. Spike if `npm pack` of a workspace package resolves
  `workspace:` deps that must be rewritten.
- **Decision gates:** none.

---

## PACKET LIVE-8: Docs / skill truth — align every instruction surface with the shipped binary

- **Goal:** No installed or shipped doc tells an agent to run a command the deployed binary rejects.
- **Scope:** `docs/spec/backlog/PLUGIN_ARCHITECTURE.md`, `entrypoint/backlog/RAG-SPEC.md`,
  `AGENTS.md`, `entrypoint/backlog/{SPEC.md,DATA_MODEL.md,README.md,src/write/CONTRACT.md}`,
  `entrypoint/backlog/skill/SKILL.md` (+ `dist/skill/SKILL.md`), and the host skill copies. Non-goals:
  building the embedding funnel (`9987d063` only asks the docs tell the truth about it).
- **Inputs:** `9987d063` (`PLUGIN_ARCHITECTURE.md:75,116` + `RAG-SPEC.md:17` present a never-built
  `embedding-remote` funnel as shipped), `251c06ed` (`AGENTS.md:26` — **main** instructs
  `backlog admin --input '{"action":"migration_status"}'`, which exits 4; the **branch** `AGENTS.md`
  already names `adhd-backlog` + the skill pointer — so the fix rides the cutover), `c46ca4a6`
  (frozen `dist/skill/SKILL.md` doubled-bin form), `d80d344e` (hand-port dropped 5 upstream doc
  updates — `SPEC.md:115-116,131-137`, `DATA_MODEL.md:102-103,118-121`, `README.md:188`,
  `skill/SKILL.md:434-437`, `src/write/CONTRACT.md:638-641`), `1e12507f` (`CONTRACT.md` line-ref table
  stale — all six `errors.ts` anchors drifted), `16d1cb95` (closed), `268790d3`, `8fb08ec8`,
  `56865633` (skill-drift cluster across `~/.claude`, `~/.config/opencode`, and the shipped asset).
- **Acceptance/DoD:**
  1. `PLUGIN_ARCHITECTURE.md`/`RAG-SPEC.md` carry an explicit "NOT IMPLEMENTED — design only" banner
     or are reworded to the actual per-process behaviour; neither asserts a funnel as shipped.
  2. `AGENTS.md` on `main` names `adhd-backlog` and points at `entrypoint/backlog/skill/SKILL.md`;
     no bare `backlog` command, no `admin`/`migration_status` instruction.
  3. The branch re-applies `7875d848`'s five doc hunks (independent of the hand-port's code location).
  4. `CONTRACT.md`'s anchor table resolves: every cited `errors.ts` line is the actual anchor line, or
     the table switches to symbol-only anchors + a tiny drift check.
  5. The shipped `skill/SKILL.md` and both host copies are byte-identical to the package asset, and
     **every example's bin form is one the installed binary accepts**.
  - **Negative control:** for (5), execute each SKILL.md example against the built binary; the doubled
    `adhd-backlog backlog <verb>` vs single-token `backlog <verb>` question must be **settled by
    running it**, not by assertion (the spec §1 says v3 requires the `backlog` namespace segment; item
    `c46ca4a6` claims the doubled form is invalid — one of them is wrong; record which and fix to match).
- **Tests:** `P4` from the spec (a script asserting host-copy byte-equality + no bare `backlog` + every
  instruction names `adhd-backlog`) run after every release; the CONTRACT.md drift check; a doc-vocab
  gate already exists (`entrypoint/backlog/project.json` `vocabulary-gate`) — extend it if it can catch
  the doubled-bin form.
- **Dependencies:** LIVE-1 (the branch's `AGENTS.md` is the correct one — it must reach `main`),
  LIVE-2 (the canonical bin name must be final before the docs assert it).
- **Size/tier:** M · executor hint: `refactor`/docs, `test`.
- **Risks/unknowns:** the doubled-bin contradiction (above) — a spike may be needed if the frozen
  binary's actual surface differs from the branch's `SKILL.md`. `9987d063` and the funnel BUG share a
  doc family with the **embedding-domain** architect's items (`c904f526`) — keep the edit disjoint.
- **Decision gates:** none.

---

## PACKET LIVE-9: Version / health surface — collapsed to a pointer

- **Status: CLOSED as a placeholder.** The orchestrator gate (assign a single owner for `2039bb80` +
  `87799e1d`) is **answered — Domain 2 owns the implementation**:
  - `2039bb80` (store never records which backlog binary/skill wrote it) → **EMBED-2**.
  - `87799e1d` (no persisted health record) → **EMBED-4**.
- **Bodies retrieved live** (2026-09-22, production store `backlog-v2.db`) — see
  `report/packets/title-only-bodies.md`: `2039bb80-2a1a-4996-b2ff-3531a510aba5`,
  `87799e1d-0dfc-41ba-b2cd-919513d7a7b6`. The earlier "absent from the scan captures" note is **stale**
  (SEQUENCE Finding F2 — Domain 2 had already read both live).
- **No Domain-1 work.** This packet writes no code; it exists only to point at EMBED-2/EMBED-4 so no
  second packet edits the health/version file. Domain 1's `LIVE-*` set does not touch
  `store-meta.ts`/`health-record.ts`.
- **Decision gates:** none (the owner decision was the only gate, and it is resolved).

---

## PACKET LIVE-10: Post-cutover config surface + runtime deploy safety

- **Goal:** The reduced production config surface is proven safe, and no runtime actor silently
  redeploys or can be broken by a future dependency bump.
- **Scope:** `~/.adhd/backlog/production/config.yaml` consumers, the service-proxy respawn path
  (sox-ecosystem), the `@tursodatabase/database` pins (sox-ecosystem manifests). Non-goals: the
  embedding funnel (`524c4bef` is a deploy-safety item, not an embedding item — keep it here).
- **Inputs:** `f78b8692` (INVESTIGATION — after cutover, `config.yaml` carries only `db.path` +
  `embedding.enabled`; no verification that no consumer still reads `migration.phase`), `524c4bef`
  (the proxy silently respawns the backend onto whatever bundle is staged — a no-operator-action
  redeploy; trigger unidentified), `cc03366b` (`@tursodatabase/database ^0.7.1` in 3 manifests — a
  future `pnpm install` could resolve `0.7.2` and break `memory_update`/schema-apply).
- **Acceptance/DoD:**
  1. Every consumer of the backlog config surface (CLI, `serve`, `install-skill`, older installs) is
     enumerated and shown not to require `migration.phase`; if any does, restore it as a tolerated
     no-op (typed config, ADR-0013 — **never** an env var).
  2. `524c4bef`: the respawn trigger is identified and either made operator-gated or documented with
     evidence; the backend is described as **peer-spawned, self-reaping** (ADR-0020) — never "daemon".
  3. `cc03366b`: `@tursodatabase/database` is pinned to exact `0.7.1` in all three manifests + relocked.
  - **Negative control:** for (1), run each enumerated consumer against a config lacking
    `migration.phase` and confirm it behaves (or the restored no-op is read); for (3), a lockfile
    check asserting the resolved version is exactly `0.7.1`.
- **Tests:** a consumer-enumeration check (the CLI's own `--help`/doctor) + a lockfile assertion for
  (3). No flags.
- **Dependencies:** LIVE-1 (post-cutover state). `524c4bef`/`cc03366b` are **sox-ecosystem** — cross-repo.
- **Size/tier:** M · executor hint: `debug`/`backend`.
- **Risks/unknowns:** `524c4bef`'s trigger is explicitly unidentified (the item retracts its own
  rebuild hypothesis) — this **requires a spike** before any fix; do not assume the rebuild cause.
- **Decision gates:** **Repo owner** — whether `migration.phase` stays removed (recommend: remove;
  restore only as a tolerated no-op if a stale consumer is proven).

---

## PACKET LIVE-11: Pre-commit / dependency-range hygiene

- **Goal:** The pre-commit gate stops flaking under concurrent agents, and `sync-deps` range fixes are
  committed by one owner instead of rejected by the hook.
- **Scope:** the pre-commit hook wiring, `tools/nx-plugins/build` `release:commit` / sync-deps path.
  Non-goals: the CPU guard (LIVE-6).
- **Inputs:** `79b7c925` (pre-commit `nx affected -t test` flakes on concurrent `dist/` rebuild races —
  retry-until-green is the current mitigation, one step from `--no-verify`), `3c504ca0` (sync-deps
  fixes ranges on disk but never commits; the pre-commit hook then fails on the mutation). Note
  `3c504ca0`'s attached proposed spec explicitly says its **premise was NOT verified**.
- **Acceptance/DoD:**
  1. A two-line `package.json` change committed while another build runs does not fail the pre-commit
     gate for a `dist/` race (deterministic, no retry).
  2. A deliberately drifted `@adhd/*` range is fixed **and** committed by one invocation; a subsequent
     pre-commit run on it does not reject.
  - **Negative control:** reproduce `3c504ca0` first (drifted range → sync-deps fixes on disk → hook
    rejects) so the fix has a red state; for `79b7c925`, hold a concurrent build and assert the gate
    passes without retry.
- **Tests:** a spec driving the sync-deps→commit path on a fixture package; a concurrency test using a
  latch/barrier (never `sleep`) for the race. Default-on.
- **Dependencies:** LIVE-3 and LIVE-4 both touch `tools/nx-plugins/build` — directory-level file-lock;
  sequence this **after** them.
- **Size/tier:** M · executor hint: `refactor`/`backend`.
- **Risks/unknowns:** `3c504ca0`'s premise is unverified — re-confirm before implementing; if the race
  is caused by nx's shared `dist/` outputs, the fix may belong in the `assets`/`build` output scoping
  (LIVE-5), not the hook.
- **Decision gates:** none.

---

## Coordination map (who owns what, to keep packets disjoint)

| Surface                                              | Owner packet                                                | Do not touch in this domain                   |
| ---------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Embedding funnel / provider / pool / lock            | embedding-domain architect                                  | any `libs/data/embed/**` change               |
| `2039bb80` + `87799e1d` (version/health)             | **Domain 2** (EMBED-2 / EMBED-4) — LIVE-9 is a pointer only | the `store-meta`/health-record implementation |
| `PLUGIN_ARCHITECTURE.md` / `RAG-SPEC.md` funnel text | LIVE-8                                                      | the funnel BUG's code fix (embedding domain)  |
| `tools/nx-plugins/build/**`                          | LIVE-3, LIVE-4, LIVE-11 (sequence: 3 → 4 → 11)              | —                                             |
| Machine-global bin/MCP/skill                         | LIVE-2, LIVE-8                                              | —                                             |

**Cross-repo note:** `ddaf7a82`, `fa894329`, `524c4bef`, `cc03366b`, `c582e60d` live in
`sox-ecosystem` / `PseudoSky- sox`, not `adhd`. Their packets need the sox-ecosystem owner's dispatch.

**Unread items:** none. `2039bb80` and `87799e1d` were retrieved live (2026-09-22) and are recorded in
`report/packets/title-only-bodies.md`; both are Domain 2's (EMBED-2 / EMBED-4) via the LIVE-9 pointer above.
