# Worktree Workflow — dependency setup, merge-safety checks, and merging onto a dirty main

**Status:** proposed convention (research + design only — nothing in this document has been implemented) · **Written:** 2026-07-17

Companion to [`package-naming.md`](./package-naming.md) — same directory, same house style: every
non-obvious claim is tagged with how it was established, so a human reviewer can tell a verified
repo fact from a sourced external claim from genuinely novel synthesis.

## Sourcing convention (read this first)

| Tag | Meaning |
|---|---|
| `[REPO]` | Read directly from this repository's files (path + line cited) or observed by a read-only command run against this repo on 2026-07-17. |
| `[RESEARCH]` | From an external doc/vendor page fetched or searched on 2026-07-17. URL cited. Snippet-sourced — treat as a lead to re-verify at implementation time, not immutable fact (vendor docs change). |
| `[MEMORY]` | From this project's prior recorded findings in the memory-server graph (UID cited). |
| `[SYNTHESIS]` | Genuinely novel reasoning by the author of this doc, not directly stated by any source above. Flagged explicitly so it gets the most scrutiny in review. |

If a sentence has no tag, it is scoping/definition, not a claim of fact.

---

## 1. Problem statement

### 1.1 The incident that motivated this document

A subagent working in `.worktrees/agent-mcp-usage-accounting` needed one new npm dependency mid-task `[SYNTHESIS: task framing, as given]`. What actually happened, reconstructed from repo state:

- This repo's `package.json` pins `"packageManager": "yarn@4.5.3+sha512..."` (Yarn **Berry**) `[REPO: package.json:143]`, but `yarn.lock` is in **Yarn Classic v1 format** — its own header says so: `# yarn lockfile v1` `[REPO: yarn.lock:1-2]`, and it is currently **19,679 lines** `[REPO: wc -l yarn.lock, 2026-07-17]` — matching the incident's starting figure exactly. Running `yarn install` under the pinned Berry binary against a Classic-format lockfile is a real, load-bearing format mismatch, not a hypothetical: Berry does not read Classic lockfiles and would silently discard it for a full unanchored re-resolution.
- `.yarnrc.yml` sets `nodeLinker: node-modules` `[REPO: .yarnrc.yml]` — i.e. even the Berry binary that *is* pinned is configured to use the classic flat `node_modules` linker, not Plug'n'Play. This matters for §3.1 below: "just fix the lockfile mismatch" does **not** by itself buy Yarn's zero-install properties — that's a second, independent decision.
- Root `package.json` declares **no `workspaces` field** `[REPO: grep -n '"workspaces"' package.json → no match]`. This repo is a single shared `node_modules` by convention, not a package-manager-native workspace — confirmed independently by an open bug: `@adhd/*` imports resolve only via `tsconfig` `paths` at build time, and `node_modules/@adhd/` is empty at runtime because "no workspace links were ever created" `[REPO: BACKLOG.md:55-58]`.
- The repo also carries a **third** lockfile, `package-lock.json` (npm format, 1.5MB, tracked in git, last touched by a commit explicitly flagged `chore(repo): commit pre-existing working-tree state (not authored this session)`) `[REPO: git log -1 package-lock.json → b1580fd6, 2026-07-09; ls -la package-lock.json]`. Nothing in `.gitignore` excludes it `[REPO: .gitignore has no package-lock.json entry]`. This is a live, tracked artifact of exactly the kind of package-manager confusion this document exists to resolve — flagged to BACKLOG in §3.4.
- `node_modules` at the repo root is **1.2GB** `[REPO: du -sh node_modules, 2026-07-17]` and includes at least one compiled **native module**, `better-sqlite3@12.10.0` `[REPO: package.json:30]` — its bindings are compiled for a specific Node ABI/platform. This is directly relevant to every dependency-sharing strategy evaluated in §3.1: anything that makes worktrees share compiled native binaries by a single literal directory reference is one Node-version mismatch away from a hard crash across every worktree simultaneously.
- The convention for a new worktree is `ln -s ../../node_modules node_modules` `[SYNTHESIS: as given in task framing, consistent with the "single shared root node_modules" fact above]` — one literal directory, referenced by symlink from every worktree. This is fast (a symlink costs nothing) but has **no isolation**: every worktree's `node_modules` **is** the same inode. A subagent's `npm install --no-save` failed reify step deleted that worktree's own `node_modules` symlink as a side effect — and because the symlink target was the literal shared directory, and a separate side-quest had already deleted a directory from within it, the result broke `nx build`/`nx test` for **every worktree in the repo simultaneously**, not just the one being worked in. This single-point-of-failure property — not the install itself — is the structural root cause, and it is what §3.1 is designed to eliminate.
- The fix required writing into the **main checkout's** `node_modules` from a session scoped to a worktree, and Claude Code's own permission classifier blocked that cross-worktree write, stalling the task. This is evidence, not a documented product limitation — no vendor page confirms or denies this classifier behavior — flagged as an open question in §4.

### 1.2 Three problems, in the order this document addresses them

1. **§3.1** — automatic worktree creation with near-zero cost when dependencies are unchanged, without repeating the single-shared-directory failure mode above.
2. **§3.2** — a merge-back playbook agents can run as one deterministic script instead of improvised multi-turn bash, so agents stop being "scared" of merging.
3. **§3.3** — merging a worktree branch onto a **dirty** main (uncommitted changes present), with `git stash` and new branches both off the table by hard repo policy `[REPO: AGENTS.md:16, AGENTS.md:12 "You do not run git stash commands ever"]`.

---

## 2. Sourced findings (external research)

### 2.1 pnpm's documented pattern is a near-exact match for this repo's failure mode

pnpm publishes an official guide titled "pnpm + Git Worktrees for Multi-Agent Development" `[RESEARCH: https://pnpm.io/git-worktrees, fetched 2026-07-17]`. Verbatim framing: *"Git worktrees enable multiple AI agents to work simultaneously on different branches of the same repository, each with isolated working directories and `node_modules`, while sharing git objects and dependency content through pnpm's global virtual store."*

Setup (quoted): a bare clone, `git worktree add` per branch, then in `pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
enableGlobalVirtualStore: true
```
then `pnpm install` **once per worktree**. The documented mechanism: with the global virtual store enabled, "each worktree's `node_modules` contains only symlinks into a single content-addressable store on disk" — each worktree gets **its own** `node_modules` directory (of symlinks), not a shared literal directory. First install populates the store; every subsequent worktree's install is "nearly instant because they only create symlinks to the same store." `[RESEARCH: same URL]`

**The load-bearing distinction vs. this repo's current approach:** the current `ln -s ../../node_modules` scheme makes N worktrees share **one inode** — deleting/mutating it from any worktree mutates it for all. pnpm's global-virtual-store scheme makes N worktrees each own **their own** directory of symlinks into one shared *content* store — deleting a worktree's `node_modules` deletes only that worktree's symlink tree; the content store and every sibling worktree's directory are untouched. This is a structural, not incremental, fix for the exact incident in §1.1. `[SYNTHESIS]`

The pnpm doc also states the caveat verbatim: *"This setup assumes the worktrees and agents share the same trust boundary. Do not use one writable pnpm store for mutually untrusted agents or users."* `[RESEARCH: same URL]` — not a concern for this repo (single operator + their own agents), but worth recording as a boundary condition.

pnpm's separate global-virtual-store doc `[RESEARCH: https://pnpm.io/global-virtual-store, fetched 2026-07-17]` adds one caution not in the worktree guide: *"The global virtual store and the content-addressable store are shared writable state"* — recommended for "projects, users, and jobs that trust each other," with the store path protected by filesystem permissions. It does **not** document a specific corruption scenario between worktrees (i.e., pnpm's own docs don't claim the isolation is bulletproof, only that each worktree's `node_modules` is a separate directory — which is the property that matters here).

#### 2.1.1 "Nearly instant" empirically checked against this repo's real dependency tree — it is NOT `[REPO: measured 2026-07-17, see methodology below]`

The "nearly instant" framing above is a vendor claim, marked `[RESEARCH]`, not verified. It was checked directly: this repo's exact root `package.json` (2,461 resolved packages, including the native module `better-sqlite3` and other packages with install-time build scripts — `nx`, `@swc/core`, `esbuild`, `cypress`, `@parcel/watcher`, `core-js`, `unrs-resolver`) was copied into two scratch directories fully outside the repo tree (to avoid corepack inheriting this repo's pinned `packageManager`), sharing one explicit `--store-dir`. First attempt silently produced a misleadingly fast number (`Ignored build scripts` warning — pnpm 10 blocks lifecycle scripts by default, including `better-sqlite3`'s, meaning the package would not actually work) — corrected by adding `pnpm.onlyBuiltDependencies` to `package.json` before install, per pnpm's own default-lifecycle-script-blocking behavior in v10 `[RESEARCH: pnpm.io/package_json, socket.dev/blog/pnpm-10-0-0-blocks-lifecycle-scripts-by-default, fetched 2026-07-17]`.

Real, timed results (`time pnpm install`, wall-clock, no scripts skipped):

| Run | Store state | Real time |
|---|---|---|
| Worktree A (first ever install) | Empty store, empty `node_modules` | **31.7s** |
| Worktree B (second worktree, same store) | Store already populated by Worktree A | **18.6s** |

**Correction to the vendor framing: a second worktree against a warm store is ~40% faster than a cold install, not "nearly instant."** 18.6 real seconds is a substantial, repeatable cost for every new worktree, even with the store fully warm — not the near-zero number the marketing language implies. This matters directly for the stated goal in §1.2: "0 consumed time for changes that don't change `node_modules`." pnpm's global virtual store does not deliver that goal by itself; it only reduces cold-install cost by roughly a third. **Consequence for §3.1.3's hash-gated fast path: it is not an optional nicety, it is the only part of this design that can actually deliver near-zero cost.** When the dependency hash is unchanged, the fast path must skip invoking `pnpm install` entirely (e.g. a direct filesystem copy/link of an already-built sibling worktree's `node_modules`, verified against the hash) rather than relying on pnpm's own CLI to be fast — pnpm's CLI overhead (resolution, lockfile diffing, symlink-tree construction for 2,461 packages) is real and measured, even when zero bytes need to be fetched. `[SYNTHESIS, informed by the measurement above]`

### 2.2 Yarn Berry PnP/zero-installs would require a second migration this repo hasn't decided on, and has a real compatibility risk given this repo's native dependency

Yarn Berry's Plug'n'Play mode replaces `node_modules` with a single `.pnp.cjs` resolver file; "Zero-Installs" additionally commits the package cache so `yarn install` is never required after a clone/branch switch `[RESEARCH: multiple sources, incl. dev.to/spencercarnage/yarn-modern-with-plugnplay-and-zero-installs-6k8, fetched 2026-07-17]`. This is directly relevant to "0 consumed time for unchanged deps" — but two things weaken it as *this repo's* fix:

- Per §1.1, `.yarnrc.yml` already sets `nodeLinker: node-modules`, i.e. this repo has already opted **out** of PnP even under the currently-pinned Berry version. Fixing the Classic/Berry lockfile-format mismatch (making `packageManager` and `yarn.lock` agree) is a **smaller, more urgent** fix than also flipping `nodeLinker` to `pnp` — the two are separable decisions and should not be bundled.
- A Yarn Berry maintainer discussion titled "Zero install can lead to runaway repo size, doing permanent damage" documents that repos with large/frequently-changing dependencies can see the committed cache balloon the repo history by an order of magnitude, and that this "cannot be truly fixed without eliminating or rewriting the entire history of the repository" `[RESEARCH: github.com/yarnpkg/berry/discussions/4845, fetched 2026-07-17]`. This repo's `node_modules` is already 1.2GB `[REPO, §1.1]` — a real risk if zero-installs (committing the cache) were adopted without first assessing dependency churn.
- PnP has known ecosystem-compatibility gaps: "many tools don't support PnP," and IDE integration requires an extra `yarn dlx @yarnpkg/sdks` step `[RESEARCH: pockit.tools/blog/pnpm-npm-yarn-bun-comparison-2026, fetched 2026-07-17]`. Compiled native modules are historically PnP's weakest spot (prebuilt-binary and `node-gyp` postinstall flows generally assume a classic flat `node_modules` layout) — general industry knowledge, not independently re-verified against `better-sqlite3` specifically in this session; **this is exactly the kind of claim that needs a real spike before committing to PnP**, not a decision this document makes for you `[SYNTHESIS — flagged low-confidence, needs verification]`.

Net: Yarn Berry PnP is a legitimate root-cause fix in the abstract, but for *this* repo it is a larger, two-part migration (fix the lockfile mismatch, *then* separately decide on PnP) with a real native-module risk that pnpm's global-virtual-store approach does not carry (pnpm's default `node-modules` linker preserves ordinary Node resolution — no PnP compatibility shims needed anywhere in the toolchain).

### 2.3 Nx has recently added worktree-aware *build* caching — but that is a different layer than dependency installation, and this repo is 4 major versions behind it

Nx's own blog, "How Git Worktrees Changed My AI Agent Workflow" `[RESEARCH: https://nx.dev/blog/git-worktrees-ai-agents, fetched 2026-07-17]`, documents a recommended worktree folder layout and `git worktree add`/`remove` commands, but **explicitly does not address `node_modules` management** — its own problem statement only notes that switching branches traditionally means you'd "potentially re-install `node_modules`," with no solution offered for worktrees. Its own manual-setup instructions end with: *"Remember to initialize your development environment in each new worktree: install dependencies, set up virtual environments, or run whatever your project's setup requires"* `[RESEARCH: https://code.claude.com/docs/en/worktrees, fetched 2026-07-17 — this exact sentence is from Claude Code's own worktree docs, not Nx's, but makes the identical point]`. **Both vendors punt this problem to the project.** This is useful negative evidence: there is no "just turn on flag X" vendor-native answer to `node_modules`-across-worktrees; it genuinely requires the package-manager-level design in §3.1.

Separately, Nx 22.6+ added **worktree-aware task caching**: *"Nx now uses the same cache across git worktrees, so building in one worktree and switching to another gives you a cache hit instead of a rebuild... saves disk space since artifacts live in one place instead of being duplicated per worktree,"* explicitly called out as valuable "for parallel agentic development, where it's common to spin up several worktrees and run a different agent in each" `[RESEARCH: https://nx.dev/blog/nx-22-7-release, fetched 2026-07-17]`. Nx 22.7 additionally added **task sandboxing** (monitors real file I/O during a task against declared `inputs`/`outputs` and flags violations) `[RESEARCH: same URL]`.

This is a **different layer than the problem in §1.1** — it shares the `dist`/build-output cache across worktrees, not `node_modules`/installed-dependency state — but it is a real, relevant complementary improvement. It does **not** apply today: this repo pins **Nx 18.3.4** `[REPO: node -e "require('nx/package.json').version" → 18.3.4]`, four majors behind. Upgrading Nx is its own initiative with its own risk surface (this repo's memory already records Nx daemon/project-graph fragility unrelated to version, e.g. a wedged daemon reporting "Failed to process project graph" after unrelated file moves `[MEMORY: 01KXP9Y2E0ZVJ3JD61JR6HP354]`) and is **out of scope to bundle into this document's recommendation** — tracked as a distinct, independent BACKLOG item in §3.1.4.

### 2.4 `git merge-tree --write-tree` is a zero-side-effect merge-safety primitive purpose-built for problem 2

Modern `git merge-tree` (the `--write-tree` mode, not the legacy pre-2.38 mode) performs a full three-way merge — content merges, rename detection, recursive-ancestor consolidation, the same engine `git merge` uses — but **touches neither the working tree nor the index, and creates no commit** `[RESEARCH: https://git-scm.com/docs/git-merge-tree, fetched 2026-07-17]`. It writes a tree object and reports:

| Exit status | Meaning |
|---|---|
| `0` | Clean merge, no conflicts |
| `1` | Merge has conflicts (parseable per-file conflict list on stdout) |
| `≥2` | Error — merge could not complete |

Because it mutates nothing, it needs **no cleanup regardless of outcome** — a materially different property than `git merge --no-commit --no-ff`, which *does* stage the merge result into the working tree/index and requires an explicit `git merge --abort` on conflict `[RESEARCH: multiple sources, incl. git-scm.com/docs/merge-options, fetched 2026-07-17]`. That makes `merge-tree` the correct **first gate** in §3.2's playbook: an instant, side-effect-free conflict check an agent can run unconditionally without any risk of leaving the repo in a half-merged state if it forgets a cleanup step.

### 2.5 Claude Code's own worktree tooling confirms the "ephemeral, auto-cleaned worktree" pattern is already native to this environment

Claude Code's docs `[RESEARCH: https://code.claude.com/docs/en/worktrees, fetched 2026-07-17]` document `isolation: worktree` as legitimate subagent frontmatter — *"Each subagent gets a temporary worktree that is removed automatically when the subagent finishes without changes"* — and a `WorktreeCreate` hook that *"replaces the default `git worktree` logic entirely,"* reading a name from stdin and printing back whatever directory it created (this document's own dispatch-agent tool description uses exactly this: `isolation: "worktree"` creates a temporary worktree, auto-cleaned if no changes were made — the mechanism is not hypothetical, it's the tool being used to write this very document).

Two repo-relevant facts fall out of this:
- Claude Code's own `--worktree` flag defaults new worktrees to `.claude/worktrees/<name>/`, **not** `.worktrees/<name>/` `[RESEARCH: same URL]`. This repo's convention is `.worktrees/` `[REPO: user's global CLAUDE.md, "git worktrees are always within `<project>/.worktrees/`"]`. Both patterns currently coexist on disk: `git worktree list` shows `.worktrees/agent-mcp-usage-accounting` **and** `.claude/worktrees/impl-ephemeral` side by side `[REPO: git worktree list, 2026-07-17]`. A `WorktreeCreate` hook can override the default location entirely (it "replaces the default git worktree logic"), so this is reconcilable — see §3.1.5 — but it is a real, live inconsistency worth fixing deliberately rather than by accident.
- A resumed/no-name worktree with **no uncommitted changes** is reset to the current base branch automatically on next entry `[RESEARCH: same URL]` — i.e. Claude Code's own tooling already treats "clean worktree, no local drift" as safe to silently fast-forward. This is consistent with (and gives some product-level precedent for) the hash-gated fast path proposed in §3.1.3.

### 2.6 Industry framing on agent merge safety: PR-gated human review is the default; local-merge equivalents need an explicit stand-in

Across Devin/Cursor/Copilot-style agent products, auto-merge without human review is generally discouraged — "the PR review gate is the last safety net before an agent's mistake hits production" `[RESEARCH: techsy.io/en/blog/background-coding-agents-compared, fetched 2026-07-17]`. When multiple agent branches merge sequentially, the recommended practice is to run the test suite after **each** merge so a regression can be attributed to the specific merge that caused it `[RESEARCH: blog.vibecoder.me/multi-agent-coding-orchestrating-ai-agents, fetched 2026-07-17]`. This repo's workflow (local worktree → local main, no hosted PR) has no direct equivalent of "PR review" today; §3.2 treats the merge-check script's PASS as the local stand-in and flags the human-approval question explicitly as open in §4 rather than deciding it unilaterally.

---

## 3. Recommended design

### 3.1 Problem 1 — automatic, near-zero-cost worktree dependency setup

**Chosen approach: migrate to pnpm with `enableGlobalVirtualStore: true`, plus a hash-gated setup script wired to a `WorktreeCreate` hook.** Two independent layers, both required:

#### 3.1.1 Why pnpm's global virtual store over the alternatives

| Approach | Isolation | Cost when unchanged | Verdict |
|---|---|---|---|
| Shared literal `node_modules` (current) | **None** — one inode for every worktree; the exact cause of the §1.1 incident | Zero (symlink) | Rejected — already proven to fail catastrophically |
| Fresh per-worktree install (`npm ci`/`yarn install` per worktree) | Full | Full install cost every time (this repo's `node_modules` is 1.2GB `[REPO, §1.1]`) | Rejected — violates the stated "≈0 time for unchanged deps" goal |
| pnpm + `enableGlobalVirtualStore`, via `pnpm install` directly | Per-worktree `node_modules` (own directory), backed by one shared content store | **18.6s measured** for a warm-store second worktree, vs. 31.7s cold `[REPO, §2.1.1]` — real, not "nearly instant" | Isolation chosen (§3.1.1 below); speed claim corrected — see §3.1.3 |
| pnpm global virtual store + hash-gated skip of `pnpm install` entirely | Same as above | **Near-zero when hash unchanged** — bypasses pnpm's CLI overhead via direct filesystem copy/link, not measured by pnpm's own install path `[SYNTHESIS, §3.1.3]` | **Chosen** |
| Yarn Berry PnP / zero-installs | Per-worktree `.pnp.cjs` (or committed cache) | Near-zero, but only after a second migration decision this repo hasn't made | Rejected *for now* — real, undecided native-module and repo-size risk (§2.2); revisit only after a dedicated spike |

pnpm wins because it is the only option that gets **both** properties the owner asked for simultaneously — real per-worktree isolation *and* near-zero marginal install cost — without requiring a second, riskier ecosystem-compatibility decision (PnP) on top of it, and without carrying the native-module risk that specifically threatens this repo's `better-sqlite3` dependency `[REPO, §1.1]`. It also directly eliminates the *class* of failure in §1.1: because `pnpm install` for a new worktree only ever writes into that worktree's own `node_modules`, an agent never needs to write into the main checkout's `node_modules` from a worktree-scoped session — which is exactly the operation Claude Code's permission classifier blocked mid-incident (§1.1). `[SYNTHESIS]`

#### 3.1.2 What would need to change (named, not implemented)

- **Package-manager migration, human-approved.** AGENTS.md requires human approval before installing external tools (`"You always get human approval before installing external tools"` `[REPO: AGENTS.md:21]`) and evaluating best-of-class 3rd-party tools before authoring (`AGENTS.md:20`) — this document is that evaluation; the migration itself still needs explicit sign-off. Concretely: add `pnpm-workspace.yaml` at repo root with `packages: ['packages/*/*', 'entrypoint/*']` (matching the existing `<domain>/<domain>-<tier>-<name>` layout) and `enableGlobalVirtualStore: true`; retire `yarn.lock` **and** `package-lock.json` (the latter is already stray junk, §1.1/§3.4) in favor of `pnpm-lock.yaml`; update `package.json`'s `packageManager` field to a pinned `pnpm@<version>`; update `.yarnrc.yml` removal and any CI/`PUBLISHING.md` references to `npm`/`yarn install` (`PUBLISHING.md` currently documents `npm login`/`npm publish`/`npm version` flows `[REPO: PUBLISHING.md]` — these are npm-registry commands, not npm-the-package-manager, and are unaffected by a client-side pnpm switch, but should be re-verified once pnpm is in place).
- **A worktree setup script**, e.g. `scripts/worktree-setup.sh` (not yet written — named per convention; per `package-naming.md` this is correctly a `scripts/` entry, not a `packages/` library, since it has zero importers by construction `[REPO: package-naming.md "Where things do NOT go"]`). It performs §3.1.3's hash gate, then either no-ops or runs `pnpm install` inside the target worktree.
- **A `WorktreeCreate` hook** in `.claude/settings.json` wiring worktree creation to `git worktree add .worktrees/<name>` (not Claude Code's own `.claude/worktrees/` default — see §3.1.5) followed by invoking the setup script. **Not implemented here** — `update-config` is the skill that owns `settings.json` edits, and this document is scoped to research + a written proposal only.
- **BACKLOG entry** (added live in §3.4) tracking the migration as a single coordinated piece of work, since it touches the lockfile, CI, `PUBLISHING.md`, and every worktree simultaneously.

#### 3.1.3 The hash-gated fast path (complementary, package-manager-agnostic)

Independent of the pnpm decision, `scripts/worktree-setup.sh` should implement a hash gate so the *decision* of whether to do any install work at all is itself instant and mechanical, mirroring the same pattern CI systems use to key a dependency cache on a lockfile hash `[RESEARCH: e.g. GitHub Actions `hashFiles('package-lock.json')` keyed caching, starsling.dev/best-practices/github-actions/cache-dependencies, fetched 2026-07-17]`:

1. Compute a hash of `package.json` + the lockfile (`pnpm-lock.yaml` post-migration).
2. Compare against a stored hash from the main checkout's last known-good install (e.g. `tmp/.worktree-deps.hash`, honoring this repo's single-canonical-ephemeral-root rule `[REPO: AGENTS.md:249-256, "There is exactly one canonical root: `tmp/`"]`).
3. **Unchanged:** do **not** invoke `pnpm install` at all — measured at 18.6s even warm (§2.1.1), it is not free. Instead, directly copy or hardlink an already-built sibling worktree's (or the main checkout's) `node_modules` directory into the new worktree — a filesystem operation, not a package-manager operation, and the only path that actually delivers "0 consumed time." pnpm's virtual store still matters here: it's what makes that copied/linked `node_modules` safe and space-cheap regardless of which worktree it was built in.
4. **Changed:** run a real `pnpm install` (real cost, ~20-35s per §2.1.1 — cannot be avoided when dependencies genuinely changed), then update the stored hash.

This gives the owner's literal ask — "0 consumed time for changes that don't change `node_modules`" — as a mechanical, unconditional check rather than something an agent has to remember or judge, and it does not depend on pnpm's own install path being fast, because measurement showed it isn't.

#### 3.1.4 Nx worktree-aware caching — tracked, not bundled

Upgrading to Nx ≥22.6 to get shared build-cache across worktrees (§2.3) is a real complementary win but a separate, riskier initiative (major-version Nx upgrade, 4 versions behind `[REPO, §2.3]`) — **log to BACKLOG as its own item, not folded into this migration.**

#### 3.1.5 Reconcile the `.worktrees/` vs `.claude/worktrees/` split

Both directories currently hold live worktrees in this repo (§2.5). A `WorktreeCreate` hook is the mechanism to make Claude Code's own `--worktree` flag (and the `EnterWorktree` tool) create worktrees at `.worktrees/<name>` instead of its own default, unifying the convention — recommended as part of the same settings change in §3.1.2, but flagged separately since it's a distinct decision (location convention) from the dependency-setup automation.

---

### 3.2 Problem 2 — a deterministic merge-back playbook: `scripts/worktree-merge-check.sh`

**Chosen approach: a three-stage script combining `git merge-tree` (free, unconditional first gate) with an ephemeral scratch-worktree merge+scoped-build/test (only if stage 1 is clean), always self-cleaning, emitting one machine-parseable verdict.**

Specified here for a human to review before anyone implements it — **not written yet**, per this task's scope.

#### 3.2.1 Why this beats the alternatives considered

- **Plain `git merge --no-commit --no-ff` as the sole check** (the SCOPE's initial suggestion) works, but *mutates* the working tree/index and requires an explicit `git merge --abort` cleanup step on every conflict path — one more thing an agent can forget or get wrong mid-multi-turn-bash, which is the exact "scared, improvised bash" failure mode being fixed. `git merge-tree` (§2.4) does the same conflict detection with **zero mutation and zero cleanup obligation**, so it should run *first*, unconditionally, before anything riskier is attempted. `[SYNTHESIS, informed by RESEARCH §2.4]`
- **Running the real build/test only after the free check passes** keeps the common case (a conflict-free merge) fast, and reserves the more expensive step (spin up scratch worktree, install deps, build/test) for merges that have already cleared the cheap gate.
- **A disposable scratch worktree, not the agent's real worktree or main**, for the build/test step — matching the same `isolation: worktree` / "removed automatically when finished" pattern Claude Code's own subagent tooling already uses `[RESEARCH, §2.5]`. This means "discard" is a single `git worktree remove --force`, unconditionally, regardless of outcome — no risk of leaving the agent's actual working state, or main, touched by a merge attempt that turned out to be unsafe.
- **A single verdict with a distinct exit code per failure class**, not prose the agent has to parse, so the "act on it" step is a `case` statement, not a judgment call.

#### 3.2.2 Exact behavior to specify (before implementation)

```
scripts/worktree-merge-check.sh <source-branch> [<target-branch, default: main>]
```

1. **Stage 1 — free conflict check.** `git merge-tree --write-tree <target> <source>`. Exit 1/≥2 → **FAIL, reason=CONFLICTS** (or `reason=MERGE_ERROR`), print the parsed conflicted-file list (`git merge-tree`'s own machine-parseable stage-info lines, §2.4), **stop here** — nothing was touched, nothing to clean up.
2. **Stage 2 — ephemeral merge + scoped verification**, only if stage 1 passed:
   - Create a scratch worktree at the target branch's tip (e.g. `git worktree add <tmp-path> <target>`; per this repo's `tmp/` convention `[REPO: AGENTS.md:249-256]`, use `tmp/worktree-merge-check/<uuid>` — a real edge case: `tmp/` is git-ignored but `git worktree add` requires the *path* to not itself be tracked or dirty, not that it live outside `tmp/`, so this is compatible).
   - `git merge --no-commit --no-ff <source>` inside the scratch worktree. A conflict here (despite stage 1 passing) would indicate a bug in the check, not a real conflict — treat as `reason=INTERNAL_ERROR`.
   - Run §3.1's hash-gated dependency setup inside the scratch worktree (near-zero cost if deps didn't change, per §3.1.3).
   - Compute the Nx projects touched by `git diff --name-only <merge-base(target,source)> <source>`, and run `npx nx affected -t build test` scoped to that changed set (not a full-repo build) — keeps the check fast enough that an agent will actually run it every time instead of skipping it.
   - Capture the real exit code (per this repo's own "trust exit codes, not stdout" testing rule `[REPO: AGENTS.md:201, "4. Trust exit codes, not stdout"]`) — not `grep`, given this exact class of self-inflicted false-pass is already documented as having happened once in this repo's own history `[MEMORY: 01KXP9SKZX4HSWX9HDBQK6R25K — an agent reported a cached "Successfully ran target test" line as a real pass, and separately reported grep's exit code instead of nx's]`.
   - **Always** `git worktree remove --force <tmp-path>` at the end, success or failure — cleanup is unconditional, not agent judgment.
3. **Verdict.** Exit code convention: `0` = safe to merge (both stages clean); `1` = merge-tree conflicts; `2` = merges cleanly but build/test fails on the merged result; `3` = internal/setup error (e.g. scratch worktree creation failed). Print a one-line machine-parseable summary plus the specific reason (conflicting files, or the failing Nx project/target) so the agent's next action is a lookup, not a re-diagnosis.

#### 3.2.3 What this does *not* decide

Whether a script `PASS` is itself sufficient authorization to merge, or whether this repo wants a hard human-approval gate before any worktree→main merge regardless of the script's verdict, is **not resolved by this document** — flagged explicitly in §4, informed by the industry norm that PR-style human review is the default safety net for agent-authored merges elsewhere `[RESEARCH, §2.6]`, weighed against this repo's existing practice of trusting agents to commit directly.

---

### 3.3 Problem 3 — merging a worktree branch onto a dirty main, no stash, no new branch

**Chosen approach: a three-set decision tree (disjoint fast path vs. genuine intersection), using git's own documented merge-safety behavior for the common case, and `git merge-file` + single-path `git restore` for the genuinely-overlapping case — with an explicit, honest boundary where automation stops and a human decision is required.**

#### 3.3.1 The git mechanics, precisely

`git read-tree`'s merge safety check (the same machinery `git merge` uses per-file) is documented as: *"If you have local changes in the working tree that would be overwritten by this merge, git read-tree will refuse to run to prevent your changes from being lost... This is done to prevent you from losing your work-in-progress changes, and mixing your random changes in an unrelated merge commit"* `[RESEARCH: https://git-scm.com/docs/git-read-tree, via search fetched 2026-07-17]`. Concretely, for any given path:

- If the incoming branch does **not** actually change that path relative to the merge-base (no diff for that path between merge-base and the incoming branch), git leaves an uncommitted working-tree edit to that path **completely untouched** and merges everything else normally — *"your changes do not interfere with the merge, and are kept intact"* `[RESEARCH: same URL]`. **No stash is needed for this case — plain `git merge` already does the right thing today.**
- If the incoming branch **does** change that path, and the working tree has an uncommitted edit to the same path, git refuses the **entire merge** up front with `error: Your local changes to the following files would be overwritten by merge: <files>. Please commit your changes or stash them before you merge.` `[RESEARCH: multiple sources, e.g. github.com/git-tfs/git-tfs/issues/1080, labex.io/tutorials/..., fetched 2026-07-17]` — a hard, clean stop, not a partial merge; nothing is left half-applied.

#### 3.3.2 The mechanical decision tree

```
DIRTY     = files with uncommitted (staged or unstaged) changes on main   → `git status --porcelain`
INCOMING  = files the branch actually changed relative to the merge-base → `git diff --name-only main...<branch>`
                                                                             (triple-dot: diffs from the merge-base,
                                                                              matching what git's own merge machinery
                                                                              considers "touched")
OVERLAP   = DIRTY ∩ INCOMING
```

**Case A — `OVERLAP` is empty (expected to be the common case in this per-package monorepo, since a feature branch typically touches one package and unrelated uncommitted work on main typically sits elsewhere).**
Run `git merge <branch>` directly. Per §3.3.1 this is guaranteed to succeed and to leave every `DIRTY` file exactly as it was, uncommitted, sitting on top of the new merge commit. Nothing further is required; committing the (still-uncommitted) `DIRTY` files is a separate, later decision, not forced by the merge. **Fully automatable — no human decision needed.**

**Case B — `OVERLAP` is non-empty.** For each file in `OVERLAP`, apply this per-file procedure (no stash, no new branch, does not touch any file outside `OVERLAP`):

1. Save the file's current (dirty, uncommitted) content aside (e.g. copy to a scratch path under `tmp/`).
2. `git restore --source=HEAD <file>` — restores **this one named file** to match `HEAD`. This is explicitly the sanctioned single-file form of the operation the repo's own ban carves out: *"To discard one file: `git restore <path>`"* `[REPO: AGENTS.md:17]` — the ban is on whole-tree restores (`git restore .` / `git checkout -- .`), never on a single named path. The file is now clean, so it no longer blocks the merge.
3. Once every `OVERLAP` file has been restored this way, `git merge --no-commit <branch>` now succeeds (nothing left uncommitted-and-touched), updating every `OVERLAP` file to the branch's version, staged but not committed.
4. For each `OVERLAP` file, 3-way merge the saved-aside dirty content back in **on top of** the just-merged result, using `git merge-file <current> <base> <other>` — the standard RCS-style three-way file merge, the same primitive `git merge` itself uses internally `[RESEARCH: https://git-scm.com/docs/git-merge-file, fetched 2026-07-17]`:
   - `<current>` = the file's now-merged working-tree content (from step 3) — this is what gets overwritten with the merged result.
   - `<base>` = the original `HEAD` content (what step 2 restored to) — the common ancestor for this 3-way merge.
   - `<other>` = the saved-aside dirty content (from step 1).
   - Exit `0` = clean merge, no overlap between the incoming branch's change and the local dirty edit within that file — `git add` it, it's now part of the merge.
   - Exit **positive** = that many conflicts, i.e. the branch and the local dirty edit touched the **same lines** — `git merge-file` leaves standard `<<<<<<< / ======= / >>>>>>>` conflict markers in place `[RESEARCH: same URL]`.
5. If every `OVERLAP` file resolved cleanly (step 4 exit 0 for all): `git commit` finalizes the merge, now carrying both the incoming branch's change *and* the previously-uncommitted local edit, combined, in every `OVERLAP` file — this satisfies the owner's literal ask ("apply their edits to the uncommitted changes if they conflict, and commit them").
6. If **any** `OVERLAP` file has real conflict markers from step 4: **stop before committing.** Present the conflict-marked file(s) to a human. **This is the one point in the whole tree that is genuinely not safe to automate** — same line, two independent edits, no way to infer intent — and claiming otherwise would violate this repo's own diagnostic discipline (`"No Guessing: If an error occurs, do not guess the cause"` `[REPO: AGENTS.md, "🔍 Diagnostics" section]`).

#### 3.3.3 Honesty about scope: recommend shipping Case A now, Case B as a tracked follow-up

Case A requires no new tooling — it's a documented fact about `git merge`'s own behavior, and the fix for "agents burning tokens then quitting" is largely just **telling agents this is safe** (this document, cited from `AGENTS.md`) so they stop pre-emptively improvising defensive bash before ever attempting the merge. Case B's procedure is real and mechanically sound, but is meaningfully more script surface (per-file restore/merge-file looping, scratch-copy bookkeeping, conflict-marker detection) for a case this repo's own per-package directory layout should make comparatively rare. **Recommendation: implement and document Case A immediately (a short decision-tree note or a thin wrapper script); track Case B's automation as a distinct, lower-priority BACKLOG item, with an explicit, disclosed fallback of "stop and ask a human" for `OVERLAP`-non-empty merges until Case B is built.** This mirrors this repo's own "ship a correct partial tool over a risky complete one" instinct rather than promising more automation than has been proven safe today.

---

## 4. Open questions / tradeoffs (not resolved by this document)

1. **Does a `worktree-merge-check.sh` `PASS` (§3.2) authorize an agent to merge unsupervised, or does every worktree→main merge still need a human look regardless of the script's verdict?** Industry practice leans toward human review as the default `[RESEARCH, §2.6]`; this repo already trusts agents to commit directly. Genuinely the owner's call, not inferable from research.
2. **Is the Claude Code permission-classifier block on cross-worktree `node_modules` writes (§1.1) a real, documented product limitation, or an artifact of this repo's specific `settings.json`?** No vendor page confirms or denies a general rule here. If pnpm's per-worktree-`node_modules` design (§3.1) eliminates the *need* for such a write in the common case, this may become moot in practice without ever being answered — but it's worth a direct test once §3.1 lands, since the *setup script itself* still needs to run `pnpm install` from inside a worktree-scoped session, and it's not yet verified that this is unblocked under the current permission configuration.
3. **Native-module compatibility under Yarn Berry PnP was flagged as a risk (§2.2) but not independently spiked against this repo's actual `better-sqlite3` dependency.** If a future decision revisits PnP over pnpm, that spike needs to happen first — this document does not claim to have run it.
4. **Whether `pnpm-workspace.yaml`'s package glob (`packages/*/*`, `entrypoint/*`) needs a companion root `package.json` `"workspaces"` field, and whether adding one changes any of the `tsconfig.base.json`-alias-based resolution this repo currently relies on** (`BACKLOG.md:55-58` describes the *current* absence of a `workspaces` field as itself a bug for a different reason — unresolved `@adhd/*` imports at runtime `[REPO: BACKLOG.md:55-60]`) is a real design question for whoever implements §3.1, not answered here — pnpm workspaces would need to be evaluated against that same existing bug, since fixing one might fix or interact with the other.
5. **The exact edge case of `git merge-file`'s three-way merge succeeding "cleanly" but silently producing a semantically-wrong (not textually-conflicting) result** — e.g. two edits to non-overlapping lines that are nonetheless logically incompatible — is not detectable by `git merge-file` and is not addressed by §3.3's Case B. This is a known, general limitation of textual 3-way merge, not specific to this repo, and is exactly why Case B commits should still be reviewed, not treated as risk-free just because they merged without conflict markers.

---

## 5. BACKLOG items filed as part of this research

The following were discovered while researching this document and are logged here per this repo's disclosure policy (grounded findings filed at time of discovery, not deferred):

- **Stray tracked `package-lock.json`** (§1.1) — a third, unused lockfile format tracked in git alongside `yarn.lock`, last touched by a commit explicitly marked as pre-existing/not-authored. Should be `git rm`'d (human-approved, since removing a tracked file needs the same care as any deletion per `AGENTS.md`'s file-removal rules) once the package-manager decision in §3.1 is made — whichever manager is chosen, only one lockfile should remain.
- **Yarn Classic/Berry lockfile-format mismatch** (§1.1) — `packageManager` pins `yarn@4.5.3` (Berry) while `yarn.lock` is Classic v1 format. This is a live, confirmed defect independent of any package-manager migration decision — even if pnpm is not adopted, this mismatch will cause the exact unanchored-re-resolution behavior described in §1.1 the next time anyone runs a bare `yarn install`.
- **Nx worktree-aware caching is unavailable at the pinned Nx 18.3.4** (§2.3/§3.1.4) — tracked as a distinct, independent upgrade initiative, not bundled into the dependency-setup fix.
