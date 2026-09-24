# Agent Git Safety — can "0 possibility of cross-agent wipe" be proven?

**Status:** DRAFT — design only. Nothing here is implemented. Requires human approval before any edit.
**Author:** architect agent (deepseek-v4-flash) · **Date:** 2026-09-18
**Repo:** `/Users/nix/dev/node/adhd` — Nx 18.3.4, pnpm 8.15.9, ~35 concurrent sibling worktrees, `core.hooksPath=.githooks`.
**Read-only engagement.** No file was modified except this document. No `git` command was executed (no mutating command, and this agent has no shell). Every git-behaviour claim is either **read from a file** (cited) or **derived from git's documented model** and labelled `[reasoned]`.

---

## 0. The headline answer — the guarantee is FALSE as stated, and here is the counterexample

> *"Logically, if something goes wrong with the agent git flow, there should be 0 possibility that they accidentally wipe other agents' code."*

**Falsified.** The premise assumes per-agent isolation. This repo has **shared mutable git state** — one `.git` behind every worktree — and `refs/stash`, `refs/*`, `.git/config`, the reflog, and the object store are all global. Two agents need not share a working tree to destroy each other's work.

**Concrete counterexample (no shared working tree, two clean sibling worktrees):**

1. Agent A, in `.worktrees/a`, has uncommitted work and runs `git stash` — pushing onto the **single repo-wide `refs/stash` stack**.
2. Agent B, in `.worktrees/b`, runs `git stash pop` to set *its* work aside. Git applies **the top of the shared stack — A's stash — onto B's tree**, then drops it. A's changes now live in B's working tree and are no longer in A's; if B later reverts, they are gone.
3. Or, one command, no cooperation: Agent A runs `git stash clear` → **every stash in the repo, including B's, is dropped at once.**

Verified: `refs/stash` is a real shared ref — `.git/packed-refs:61` → `95224d9986ab1a496b1b514cae14b09772f8c0ae`. The same one-line class of failure applies to `git branch -D <B>`, `git update-ref -d refs/heads/main`, `git config core.hooksPath /dev/null`, `git reflog expire --expire=now --all`, and `git gc --prune=now`.

**Therefore the honest reframe — three separate claims, only two of which are achievable:**

| Claim | Achievable? | Mechanism |
|---|---|---|
| **C1. No agent git operation can affect another agent's refs/stash/objects/config at all** | ✅ **Only with separate object stores** (per-agent *clone*, not shared-`.git` worktree). Impossible to achieve with worktrees — they share `.git` by definition. | Structural isolation (§4.1) |
| **C2. No agent action can *permanently* destroy another agent's committed or staged work** | ✅ Achievable today, with worktrees, via a backup-ref namespace + reflog retention (§4.3). Converts "destruction" → "recovery". | Recovery guarantee |
| **C3. No agent action can destroy another agent's *uncommitted, never-staged* work** | ❌ **Not achievable by any git-only mechanism.** Working-tree-only content is not in the object store, so no ref/reflog can recover it. | Only filesystem snapshots or "never share a working tree" |

**The strongest honest claim this design can make:**
> *No agent action can permanently destroy another agent's **committed or staged** work (C2). Cross-agent destruction through the **git channels** (refs, stash, objects, config) is impossible by construction **only** when each agent has its own clone (C1). Uncommitted, never-staged work in a **shared working tree** remains permanently at risk (C3) — the current `(main)` multi-agent configuration is the standing violation.*

---

## 1. Topology facts (verified by reading, not assumed)

| Fact | Evidence |
|---|---|
| Hooks shared by all worktrees, bypassable | `.git/config:8` `hooksPath = .githooks`; `.git/hooks/` contains only `*.sample` |
| No `pre-push` hook exists | `.githooks/` = `pre-commit`, `post-commit`, `check-no-credentials.js`, `detect-mass-deletion.js` (+spec), `README.md` |
| `pre-commit` blocks 4 things: mass-deletion, secret-scan, affected lint, affected test | `.githooks/pre-commit:57-64,79-83,105-135,146-156` |
| `post-commit` warns (never blocks) and runs **even after `--no-verify`** | `.githooks/post-commit:11-13,47-63` |
| `--no-verify` is the documented escape and **defeats Gate 0** (the mass-deletion guard) | `.githooks/detect-mass-deletion.js:44-54`; the real incident `ee8d24c8` used `--no-verify` |
| `refs/stash` is global and populated | `.git/packed-refs:61` |
| **No `refs/backup/*` namespace**; humans hand-rolled ad-hoc backups as branches | `packed-refs:15` `refs/heads/backup/…`, `:33` `refs/heads/rescue/agent-client-wip` |
| ~35 real worktrees + 43 admin entries | `.worktrees/` (38 entries incl. `node_modules`, `tmp`), `.git/worktrees/` (43) |
| Reflogs exist; all-ref updates logged | `.git/logs/` present; `.git/config:5` `logallrefupdates = true` |
| `pull.ff = only` (config write away from changing) | `.git/config:29-30` |
| **No mechanical git guard for agents** — allow-list + one nx-scope hook, **no `permissions.deny` for `git reset --hard` etc.** | `.claude/settings.json:2-27` (allow), `:28-42` (PreToolUse nx hook only) |
| The nx gate **already manufactures a worse path** — measured | `.claude/hooks/check-nx-scope.sh:9-24,122-137`; `docs/plan/worktree-workflow-redesign/WORKFLOW-REDESIGN.md:551-570` (575/3631 blocked; agents pushed onto the p90-275 s broad path) |
| `lint` (and therefore `test`) **mutates tracked `package.json`** via `sync-deps` | `nx.json:169-171`; `.githooks/README.md:58-83` |
| **No ADR catalog** — `docs/decisions/` does not exist | glob `docs/decisions/**` empty; independently confirmed at `docs/plan/nx-23-upgrade/UPGRADE-PLAN.md:100-105`. `AGENTS.md:30` cites ADR-0007/0012/0015 as **cross-repo**; ADR-0012 (parallel-process enabled) is *supported* by this design, not violated |
| `prepare` re-asserts `core.hooksPath` on install | `package.json:6` |

**Not verified (no shell available):** the brief's "235 hook-blocked invocations in `(main)` and 19 unscoped `run-many` runs there." The only *tracked* measurement is 575/3,631 (15.8%) blocked, concentrated in `test`/`build`/`lint` (`WORKFLOW-REDESIGN.md:604`). Whether a `git` wrapper exists in the `~/dot/runables` shell layer (`~/.zshrc:136-141`) is also unverified. Both are labelled `(unverified)` where relied on.

---

## 2. Vector table (Part 1)

**Shared vs isolated (the crux).** Each worktree has its **own** HEAD (`.git/worktrees/<n>/HEAD`), **own index**, **own working tree**. It **shares** the object store, all `refs/*` (including `refs/stash` and tags), `.git/config`, `.git/hooks` (via `hooksPath`), reflogs, and `ORIG_HEAD`-class state. Consequence: **file-level operations are per-worktree by construction; ref/object/config operations are repo-wide by construction.**

`[reasoned]` = derived from git's documented model (not executed here). "Recoverable?" assumes default retention: reflog 90 d reachable / 30 d unreachable, `gc.pruneExpire = 2.weeks.ago`; **permanent** only after `reflog expire --expire=now` + prune.

| # | Vector | Preconditions | Blast radius | Recoverable? | Prevented today? |
|---|---|---|---|---|---|
| 1 | `git reset --hard` / `git checkout -- .` / `git restore .` **in own worktree** | invoked in own `$PWD` | **own** tracked changes (index reset too) | staged blobs: yes (index→objects). Working-tree-only: **no** | prose only (`AGENTS.md:17`). No mechanical |
| 2 | Same, aimed elsewhere: `git -C <other>`, `cd <other> && git …`, `GIT_DIR`/`GIT_WORK_TREE` leak, or a script that resolves the wrong repo root | agent/script targets another tree | **another worktree's** working tree + index | same as #1 | **none** |
| 3 | `git reset --hard` / `git clean -fd` in the **shared main checkout** while another agent is mid-edit there | ≥2 agents in `(main)` | that agent's **uncommitted** edits, instantly | **no** (working-tree-only) | prose only. **Highest-risk config; currently in use** |
| 4 | `git clean -fd` / `-fdx` | any tree | untracked **new source** (`-fd`) + ignored `dist/`,`node_modules`,`tmp/` (`-x`) | untracked source: **no**; dist/ignored: rebuildable | prose only |
| 5 | `git branch -D <other>` / `git branch -f <other> <sha>` | any worktree | another agent's **branch ref** orphaned/moved | reflog (90 d) until expire+gc | none |
| 6 | `git update-ref -d <ref>` / `git update-ref <ref> <sha>` | any worktree | **any** ref, incl. `main` (the `ee8d24c8` cousin — moving a ref without touching the tree makes every fixed file look "modified") | reflog until expire+gc | `post-commit` warns **after** the fact only |
| 7 | `git push --force` / `--force-with-lease` to a **shared remote branch** | remote write | another agent's **pushed** commits on that branch | server-side reflog / branch protection only | **none locally** |
| 8 | **`git stash` / `pop` / `clear` / `drop`** — `refs/stash` is **global** | any worktree | **every** agent's stashes; `pop` applies *another's* stash to *your* tree | stash reflog + dangling until prune; `clear`+gc = **permanent** | prose (`AGENTS.md` bans stash). **Prime suspect — verified shared ref exists** |
| 9 | `git gc` (default) | any worktree | prunes unreachable > `pruneExpire` (2 w), expires reflog (90/30 d) | safe for fresh work (within window) | git defaults |
| 10 | `git gc --prune=now` / `git prune --expire=now` | any worktree | **immediate** removal of all unreachable objects (dangling commits, popped stashes) | **no** | none |
| 11 | `git reflog expire --expire=now --all` (+ any gc) | any worktree | **the recovery net itself**, repo-wide; compound with #10 = permanent loss of everything dangling | no | none |
| 12 | `git repack -ad` | any worktree | repacks; **does not itself drop unreachable** loose objects | n/a (low risk alone) | n/a |
| 13 | `git config core.hooksPath …` / `gc.*` / `pull.ff` / `core.fsmonitor` | any worktree | **shared config** — disables *all* hooks for *every* worktree, or sets `gc.pruneExpire=now`, or flips `pull.ff` | recoverable (re-set the config) but the *effect* (a subsequent gc) may not be | none |
| 14 | `git config --global …` | any process | **machine-wide**, all repos | recoverable | none |
| 15 | `git worktree remove --force <other>` / `git worktree prune` | any worktree | deletes another worktree's **working directory** (uncommitted work) + admin dir | committed: refs survive; uncommitted: **no** | none |
| 16 | `git tag -d <tag>` | any worktree | shared release tags (`refs/tags/v*`, `agent-*@version`) | reflog until expire+gc | none |
| 17 | `.git/index.lock` contention / `rm .git/index.lock` | concurrent index writes | corrupt index if removed mid-write; transient "index.lock exists" failures | usually yes (git re-locks) | git's own lock |
| 18 | `git checkout <branch>` in shared `(main)` | ≥2 agents in `(main)` | **shared HEAD/index moves**; the other agent's next commit lands on the wrong branch | only if noticed | prose |
| 19 | `git add -A` / `git add .` / `git commit -a` | shared `(main)` | sweeps another's **in-flight** work into your commit | partially (revert) | prose (`AGENTS.md`); `detect-mass-deletion` may catch the *inverse* shape |
| 20 | `git rebase` / `commit --amend` on a shared branch, then force-push | shared branch | rewritten history others are based on | reflog locally; remote needs server protection | none |
| 21 | `git filter-branch` / `git filter-repo` | any | full-history rewrite | backup ref / clone only | none |

**What this table proves:** vectors #1, #4 (own tree) are *self*-harm; #3, #18, #19 are the **shared-working-tree** class (C3 — unfixable by git); #5–#8, #10–#16, #20–#21 are the **shared-`.git`** class (C1 — fixable only by isolation); #9, #12 are benign by default; #13–#14 are the config channel. **Nothing in the shared-`.git` class is currently prevented mechanically.** The only real mechanical layer in the repo today is the *nx-scope* PreToolUse hook, which does not touch git at all.

---

## 3. The incentive question (Part 2) — does a blocking gate encourage destructive escapes?

### 3.1 Direct answer on `pre-push`

**First, a correction of the premise: this repo has no `pre-push` hook.** The blocking gates that exist are all `pre-commit` (`.githooks/pre-commit`). So the operator's question is about a gate that would have to be *added*.

**Second, the answer on the placement itself: `pre-push` is meaningfully *safer* than `pre-commit` for destructive-escape pressure, but it is not free of it.**

- At **pre-commit**, the gate fires **before the work is durable**. The failing artifact is sitting in the working tree, and the natural (wrong) mental model is *"make the tree clean so the gate passes."* The cheapest-looking escape is a cleanup command — and `git reset --hard`/`git clean -fd`/`git stash` are exactly cleanup commands. **This is the worst placement for the hazard, and it is the placement the repo uses today.**
- At **pre-push**, the work is **already committed**. Resetting would destroy the very thing the agent is trying to deliver, so a goal-directed agent is far less likely to reach for it. The natural escapes are `--no-verify` (benign) or "fix the test." **Lower destructive-escape pressure than pre-commit.**

The hazard is **not hypothetical**: `AGENTS.md:17` bans `git reset --hard` precisely because it *"has already cost this project real work,"* and the `ee8d24c8` incident (`detect-mass-deletion.js:6-16`) was a stale-tree commit landing back over fixed files. The destructive escape has already fired under the current pre-commit placement.

### 3.2 Ranked escapes (cheapest first) and which are destructive

| Rank | Escape | Effort | Destructive? |
|---|---|---|---|
| 1 | `git commit --no-verify` (or `git push --no-verify`) | 1 flag | **Benign to files** — but it also skips Gate 0, so it disables the mass-deletion net |
| 2 | `git -c core.hooksPath= …` / `git config core.hooksPath /dev/null` | 1 flag | Benign to files, **destroys the safety net repo-wide** (shared config) |
| 3 | Weaken/delete the failing test, or `git rm` the offending file | 1 edit | **Destructive to test coverage** — and silent |
| 4 | `git checkout -- .` / `git restore .` | 1 cmd | **Catastrophic** — discards all uncommitted tracked changes |
| 5 | `git stash` (to "set the WIP aside") | 1 cmd | **Global namespace pollution**; enables #8-style cross-agent loss |
| 6 | `git reset --hard` | 1 cmd | **Catastrophic** — discards uncommitted work irrecoverably |
| 7 | `git clean -fd` | 1 cmd | **Catastrophic** — deletes untracked new source irrecoverably |
| 8 | `git gc --prune=now` / `reflog expire --expire=now --all` | 1–2 cmd | **Catastrophic** — destroys the recovery net itself |

Ranks 1–2 are the *intended* bypasses and are file-safe; ranks 3–8 are the hazard. **The danger is that ranks 4–8 are also "obvious cleanup," and a blocked agent under pressure reaches for the most obvious remedy.**

### 3.3 Gate placement — escape pressure vs blast radius

| Placement | Blocks | Local escape pressure | Destructive-escape risk | Blast radius of a mistake |
|---|---|---|---|---|
| `pre-commit` | a small, frequent action | **highest** | **highest** (work not yet durable; "clean tree" is the wrong fix) | repo-wide (shared refs/stash/config) |
| `pre-push` | delivery | high | moderate (work already committed) | repo-wide + remote |
| `pre-merge-commit` | the merge | moderate | moderate | repo-wide |
| **CI / server-side branch protection** | the **PR/merge**, not the local action | **lowest** — the local action always succeeds | **lowest** — the server has no local destructive command | remote only (server-side reflog/protection) |
| **non-blocking warn** (like `post-commit`) | nothing | none | none | none |

**Design principle (state it and hold to it):**
> **Never place a blocking gate where the cheapest escape is destructive.** Put hard enforcement as late and as far from the working tree as possible (CI / server-side). Locally, prefer a non-blocking warn plus a benign, single-flag bypass that is *cheaper* than any destructive command. A gate whose failure message names a cleanup command is a bug.

This is not theory in this repo: the nx-scope PreToolUse hook *is* a blocking local gate, and its measured effect was to push agents off a cheap targeted command onto the p90-275 s broad one — 575/3,631 invocations blocked (`WORKFLOW-REDESIGN.md:551-570`). **A gate that blocks the cheap path manufactures demand for a worse path.** A git gate that blocks commit manufactures demand for cleanup — and cleanup is the wipe.

### 3.4 What the failure message must say (make the safe path cheapest)

The current hook messages already model the right pattern — they name the **correct next command**, not a cleanup (`pre-commit:129-133,152-154`). A git gate must do the same, and add the explicit anti-remedy. Draft for a `pre-push` gate:

```
✖ pre-push: affected test failed. Push blocked — your commits are SAFE (already committed).
  Fix the cause, then push again:
      npx nx affected -t test --base=origin/main
  Do NOT "clean up" to retry — none of these are needed to push, and they destroy work:
      ✖ git reset --hard   ✖ git clean -fd   ✖ git checkout -- .   ✖ git stash
  (AGENTS.md bans these; they destroy uncommitted work and the shared stash.)
  Genuine emergency, non-destructive bypass (skips THIS gate only):
      git push --no-verify
  Already lost something? Recover, never reset:
      git reflog            git fsck --lost-found      git for-each-ref refs/backup/
```

Properties that make the safe path cheapest: (1) **assert the work is safe** — kill the "I must clean up" premise; (2) offer `--no-verify` by name as a *one-flag* benign escape (cheaper than any destructive command); (3) name the destructive commands as *forbidden and unnecessary*; (4) never print a cleanup command; (5) print the recovery path.

---

## 4. The design (Part 3)

Five options, each on isolation strength vs operational cost. **Recommended: 1 + 3 + 4 + 5 combined** (isolation where affordable, recovery always, incentives always, detection cheap).

### 4.1 Structural isolation — per-agent clone (not shared-`.git` worktree)

A clone has its **own** object store, refs, `refs/stash`, config, reflog, and hooks. **C1 becomes true by construction**: no git operation in clone A can touch clone B's refs/stash/objects/config. Cost: disk per clone, one `node_modules` per clone, one `.nx/cache` per clone.

**The cost objection is largely retired by the shared Nx cache already designed.** `WORKFLOW-REDESIGN.md §4.4` proposes `.nx/cache → ~/.adhd/nx-cache/adhd` (a symlink or `NX_CACHE_DIRECTORY`). With a shared cache, the dominant reason worktrees are attractive — cache reuse — is served *independently* of a shared `.git`. And the pnpm store is machine-global, so a fresh clone installs fast. **Recommendation: for *agents*, use `git clone` + shared Nx cache, not `git worktree`.**

**Honest limit:** a clone is only isolated for *git* channels. An agent with arbitrary bash can still `rm -rf ../other-clone`, `git -C ../other-clone …`, or `find … -delete`. And all clones share the **remote** — `git push --force` to a common branch destroys remote work. So structural isolation removes the accidental shared-`.git` class, not "arbitrary filesystem access" and not "the remote."

### 4.2 Mechanical prevention — assess honestly, do not oversell

| Mechanism | Un-bypassable for an agent with arbitrary bash? |
|---|---|
| `git` wrapper on `PATH` | **No** — `/usr/bin/git`, `command git`, `env -i`, inline `PATH=` all bypass it |
| `git` shell function / alias | **No** — `\git`, `command git`, absolute path, non-interactive shell (no rc sourced) |
| FS permissions on `.git/refs`, `.git/packed-refs`, `.git/config` | **Partial** — genuinely blocks `update-ref`/`branch -D`/`config`/`stash` *for the specific refs locked*, but (a) locking `refs/` breaks all commits, so only narrow paths (`refs/stash`, `packed-refs`, `config`) can be locked; (b) a same-UID process can `chmod` them back. Protects a specific channel, not the whole class |
| Removing the destructive verbs | **No** — git subcommands are built-in |
| **Harness-level `permissions.deny`** (Claude Code / opencode) | **Strongest practical layer for a *harnessed* agent**, but string-matched and thus obfuscatable. **Absent today** (`.claude/settings.json` has no git deny) |

**Verdict: no mechanical layer is un-bypassable against arbitrary bash.** The honest role of mechanical prevention is *friction on the obvious path*, not a guarantee. Concretely: add a `permissions.deny` block for the literal destructive verbs (`Bash(git reset --hard:*)`, `Bash(git clean -f*)`, `Bash(git stash*)`, `Bash(git checkout -- .*)`, `Bash(git update-ref:*)`, `Bash(git config core.hooksPath:*)`, `Bash(git gc --prune=now:*)`, `Bash(git reflog expire:*)`), mirroring the existing nx-scope PreToolUse hook. It stops the literal, un-hedged command — which is how an agent actually types it — and is cheap. It is **not** a proof.

### 4.3 Recovery guarantee — the achievable form of "0"

Make loss **impossible to make permanent** for committed/staged work:

1. **`refs/backup/*` namespace.** Before any integration (`pre-push`, `pre-rebase`, `pre-merge-commit`) and on a periodic tick, write `refs/backup/<branch>/<utc-ts>` = the current tip. Because `git gc` never prunes anything reachable from a ref, backup refs pin the work indefinitely. A `refs/backup/*` ref is a one-line `git update-ref` — cheap, additive, non-destructive.
2. **`post-commit` auto-snapshot.** The existing `post-commit` hook already runs unconditionally (`post-commit:11-13`). Extend it to also write `refs/backup/auto/<branch>/<ts>` and, on the *next* invocation, prune backups older than N. This captures every committed state without human action.
3. **Never shorten reflog retention.** Do not set `gc.reflogExpire*` short; keep `gc.pruneExpire` long (default 2 weeks is a floor, not a ceiling). Add a **guard** against the compound `reflog expire --expire=now` + `gc --prune=now` (the one true permanent-loss path) — either a `permissions.deny` entry or a pre-command check.
4. **Staged work is recoverable; working-tree-only is not.** `git add`ed blobs live in the object store and are protected from prune by the index; backup refs and `git fsck --lost-found` recover them. Content never `git add`ed is not in the object store and **no git mechanism can recover it** — hence C3.
5. **APFS snapshots (optional, closes C3 on macOS).** A periodic `tmutil localsnapshot` (or a cron `snapshot`) protects even uncommitted working-tree-only files. This is the only mechanism that reaches C3, and it is outside git.

### 4.4 Incentive design

- **Place hard enforcement server-side** (CI / branch protection on `main`), where there is no local destructive escape and the blast radius is the remote only.
- **Local gates warn, not block** where practical; where a local gate must block, place it at **push**, not commit.
- **Failure messages** follow §3.4: assert safety, name the fix, name `--no-verify` as the cheap benign escape, name the destructive commands as forbidden-and-unnecessary, print the recovery path.
- **Make the safe path cheapest:** `git push --no-verify` is one flag and file-safe; a destructive reset is *not* required to push at all, and the message must say so.

### 4.5 Detection — surface a wipe fast

- **Backup-diff check.** Compare each `refs/heads/*` and `refs/stash` against its `refs/backup/*` counterpart; warn if a ref moved *backwards* (non-fast-forward) or was deleted since the last snapshot. Run it at agent startup and in CI.
- **`git fsck --no-progress`** periodically for unexpected dangling commits; log, don't delete.
- **Extend `post-commit`'s precedent.** `post-commit` already detects the mass-deletion *shape* after the fact (`post-commit:47-63`). Add a parallel `post-rewrite`/`post-merge` warn for "a shared ref moved" and "a stash was dropped."
- The existing `post-commit` mass-deletion warning is the model: **detection is cheap and non-blocking; prevention is expensive and bypassable.**

### 4.6 The precise guarantee and its residual risk

**Guarantee delivered by 4.1 + 4.3 (recommended):**
> *No agent action can permanently destroy another agent's committed or staged work. Cross-agent destruction through the git channels (refs, stash, objects, config) is impossible by construction when each agent runs in its own clone. Every ref that a backup snapshot has ever seen is recoverable via `refs/backup/*`.*

**Residual risk (state plainly):**
1. **C3 remains:** uncommitted, never-staged work in a **shared working tree** is unrecoverable. Mitigation is operational: **one agent per working tree; the main checkout is human-only or single-agent.** (Until that rule holds, `(main)` multi-agent work is the live violation.)
2. **The remote is outside the clone boundary:** `push --force` to a shared branch can still orphan another's pushed commits; requires server-side branch protection + reflog.
3. **Arbitrary filesystem access is outside git's isolation:** `rm -rf`, `git -C <other>`, `find -delete` defeat clone isolation. Only OS-level permissions/snapshots address this.
4. **Harness deny is obfuscatable** and covers only harnessed agents; a raw shell agent is unguarded by it.
5. **`refs/backup/*` protects committed states only.** A stash dropped *before* it was ever snapshotted, or working-tree-only edits, are not covered.
6. **The 35 shared worktrees already exist** and are in active use; migrating agents to clones is a workflow change, not a config flip.

---

## 5. Recommended agent git flow — the exact allowed sequence

**Precondition (non-negotiable):** one agent per working tree. The main checkout is human-only (or single-agent). This is the only thing that closes C3.

**Allowed, start to finish (agent, in its own clone/worktree):**

```sh
git fetch origin                              # read-only
git switch -c agent/<id>/<slug> origin/main   # own branch, never work on main
# … edit files …
git status --porcelain                        # see exactly what you touched
git add <explicit/path> [<explicit/path>…]    # explicit paths ONLY
git commit -m "<conventional message>"        # hooks run; fix the cause if blocked
git fetch origin
git rebase origin/main                        # in YOUR branch only
git push -u origin agent/<id>/<slug>          # no --force
# … open a PR; merge server-side via branch protection …
git worktree remove "$(pwd)"                  # own worktree only (or delete own clone)
git branch -d agent/<id>/<slug>               # own, merged branch only
```

**Must NEVER run (hard bans — mechanical where possible, prose always):**

| Banned | Why |
|---|---|
| `git reset --hard`, `git clean -fd`/`-fdx`, `git checkout -- .`, whole-tree `git restore` | destroys uncommitted work irrecoverably (C3) |
| `git stash`, `stash pop`, `stash clear`, `stash drop` | `refs/stash` is global — cross-agent loss (vector #8) |
| `git branch -D` / `git branch -f` on a branch you did not create | orphans another's work |
| `git update-ref` (any form) | moves/deletes arbitrary shared refs (vector #6) |
| `git push --force`/`--force-with-lease` to `main` or any shared branch | destroys remote work |
| `git worktree remove --force` on a worktree that is not yours; `git worktree prune` | deletes another's working directory |
| `git config core.*` / `core.hooksPath` / `gc.*`; any `git config --global` | shared/machine config channel |
| `git gc --prune=now`, `git prune --expire=now`, `git reflog expire --expire=now --all` | destroys the recovery net |
| `git rebase`/`commit --amend` on `main`; `git filter-branch`/`filter-repo` | history rewrite |
| `git add -A`, `git add .`, `git commit -a` | sweeps another's in-flight work into your commit |
| `git tag -d` on a release tag | shared refs |

**On failure:**

- **Hook fails** → read the failure, **fix the cause**, re-stage explicit paths, re-commit. If genuinely blocked, `git commit --no-verify` (benign to files) — but note it also skips Gate 0.
- **Push rejected (non-fast-forward)** → `git fetch && git rebase origin/<branch>` **in your own branch**; never force. If you must force, `--force-with-lease` **only** to your own `agent/*` branch.
- **You need a clean tree and have WIP** → **do not stash.** Either leave it (a dirty tree does **not** block pushing a different branch's commits — `git push` ignores the working tree), or commit it to a throwaway `wip/<id>` branch with explicit `git add <paths>`.
- **Something was lost** → recover, never reset: `git reflog`, `git fsck --lost-found`, `git for-each-ref refs/backup/`.

---

## 6. Measured vs reasoned — honesty section

**Read from the repo (verified, cited above):** `core.hooksPath`; `pull.ff=only`; hook inventory and gate order; absence of any `pre-push` hook; the mass-deletion incident and its `--no-verify` gap; `refs/stash` present in `packed-refs`; **absence of `refs/backup/*`** (with ad-hoc `refs/heads/backup/*`, `rescue/*` instead); 38 `.worktrees/` / 43 `.git/worktrees/` entries; `logAllRefUpdates=true`; `.claude/settings.json` allow-list + single nx-scope PreToolUse hook and **no git `deny`**; the nx-scope hook's documented blocking shapes; `docs/decisions/` absent (double-confirmed).

**Reasoned from git's documented model, not executed `[reasoned]`:** worktree file/index isolation; `refs/stash`/refs/config/object/reflog sharing; reflog (90/30 d) and `gc.pruneExpire` (2 w) defaults; reachability-based gc; `push --force` remote effect. **This agent has no shell**, so no `git` command was run — including read-only ones. These are git's documented semantics, not this machine's observed behaviour.

**Unverified `(unverified)`, provided as premise and not relied on for the guarantee:** "235 hook-blocked invocations in `(main)`" and "19 unscoped `run-many` runs in `(main)`." The only *tracked* measurement is 575/3,631 blocked overall (`WORKFLOW-REDESIGN.md:604`). Also unverified: whether a `git` wrapper exists in the `~/dot/runables` shell layer (`~/.zshrc:136-141`); the object-store pack layout (the glob tool cannot traverse `.git`, so "no packs found" would be a false negative and is not claimed); whether `git gc` has ever run on this repo.

**What would change the answer:** a filesystem-level snapshot schedule (closes C3); server-side branch protection + reflog (closes residual #2); migrating agents to per-agent clones + a shared Nx cache (delivers C1); a harness `permissions.deny` on the literal destructive verbs (friction on the obvious path); and the operational rule **one agent per working tree**.

---

### Appendix — citations

- `.git/config:5,8,29-30` · `.git/packed-refs:15,33,61` · `.git/logs/`
- `.githooks/pre-commit:43,57-64,79-83,105-135,146-156` · `.githooks/post-commit:11-13,47-63` · `.githooks/detect-mass-deletion.js:6-16,44-54` · `.githooks/README.md:30-56,58-83,177-181`
- `.claude/settings.json:2-42` · `.claude/hooks/check-nx-scope.sh:9-24,122-137`
- `AGENTS.md:17,29-30` · `nx.json:169-171` · `package.json:6`
- `docs/plan/worktree-workflow-redesign/WORKFLOW-REDESIGN.md:551-570,604` · `docs/plan/nx-23-upgrade/UPGRADE-PLAN.md:100-105`
