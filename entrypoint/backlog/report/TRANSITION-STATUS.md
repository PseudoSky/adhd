# TRANSITION STATUS — adhd backlog 1.0.0 cutover

**Written:** 2026-09-24, at the end of a dispatcher session. **Audience:** a fresh session that must *finish* this transition.
**The transition has been open ~3 weeks.** It is now short and mechanical. Everything below is verified, not inferred.

---

## 1. THE CRITICAL PATH — this is the whole job

```
D5: fix the Shell-analyzer `return`s at source     [was DISPATCHED: ses_f2edb4f5effe — check if it landed]
  -> `gh pr checks 13` reports DeepSource: Shell green
    -> merge PR #13 into main
      -> publish @adhd/backlog 1.0.0 from main
        -> machine-global re-points  (largely DONE already; verify)
          -> TRANSITION COMPLETE
```

**Nothing on this path is a decision except the publish itself — and the publish is already approved.**
**Publish AFTER #13, never before** — see §4.

---

## 2. MILESTONE: `main` IS LANDED AND PUSHED

- `main` == `origin/main` == **`27830c18`** — fast-forward of `fix/backlog-funnel-provider-dep` (8 commits), pre-push gate green.
- `main` carries the post-1.0.0 source: funnel watchdog fix (`f3755c3d`), stats/rollup mount (`1859a5ae`), 5 docs commits, config cleanup (`27830c18`).
- **The `main`-vs-running-binary divergence is CLOSED.** (`main` sat untouched at `9df2a5c7` for the entire prior session.)

---

## 3. PR #13 — VERIFIED REAL STATE

```
OPEN · not draft · base=main · head chore/backlog-post-merge-followups == 0d0af873 (local == origin) · 7 commits
DeepSource: JavaScript   PASS
DeepSource: Shell        FAIL   <-- register gate D5. THIS IS THE BLOCKER.
```

Commits: `8e0d086d` filing-model docs · `ebd9bfb3` drop machine-local legacy store filename · **`a0580943` exclude non-live issues from the duplicate-candidate scan** · `70516ba6` Wave-0 preflight docs · `b8fb33ba` LIVE-1 deploy-verify check · `969d9ca9` DATA_MODEL §7 cross-link · `0d0af873` rescued BUG-050 patch.

- **D5** = register gate: *"DeepSource red → fix the `return`s at source → Analyzer gate stays red"*. Mechanical, not a decision.
- **`a0580943` touches the dedupe path** → filed item **`327870d9`** (dedupe false-negative) **must be re-verified after #13 lands**, not assumed fixed.

---

## 4. PUBLISH SEQUENCING — do not invert this

**Publish AFTER #13.** `entrypoint/backlog/package.json` ships `files: ["dist","CHANGELOG.md","skill"]` — **`skill/` SHIPS in the tarball**, and #13 is *"5 post-squash commits + the adapted doc pointer"*. Publishing first would ship the very skill/doc state #13 exists to correct. PUBLISHING.md also requires `published-state.json` committed **alongside** the version bump — the publish follows a settled tree.

---

## 5. PUBLISH MECHANICS — verified

- **`nx release` is RETIRED for this repo** (`PUBLISHING.md`; cause cited: `BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001`). ⚠️ **`AGENTS.md` §5 contradicts this** by naming `nx release publish` — one is stale; fix so they agree.
- Model is **publish-from-dist**: `@adhd/nx-build:publish` runs `npm publish {projectRoot}/dist`.
- One command: `pnpm release` (= `pnpm run build && npx nx run-many -t version && npx nx run-many -t publish`). Dry: `pnpm release:dry`.
  Narrow: `npx nx run backlog:nx-release-publish` — options `{packageRoot:"{projectRoot}/dist"}`, dependsOn `[build,test,verify-dist-load,dist-manifest,publish-hygiene]`.
- **Auth is NON-INTERACTIVE** — `~/.npmrc` has an `_authToken`; `npm whoami` = `pseudosky`. No OTP prompt will hang it.
- npm latest for `@adhd/backlog` is **`0.1.9`**; `published-state.json` caches backlog at `{version:"0.1.9", publishedFromRef:"f2bd579e…"}` → **1.0.0 is genuinely unpublished**.
- The publish's `dependsOn` re-runs the suite — where the `5b39e49b` silent-loss control lives.

---

## 6. WHAT IS ALREADY DONE (do not redo)

- `9434902c` embed-funnel process leak: **FIXED, teeth-proven green→red→green, CLOSED** (`f3755c3d`).
- Global bin **de-worktreeted**: `@adhd/backlog` → `entrypoint/backlog` (main), **17 CLI verbs + `priority-matrix` live**.
- `~/.claude.json` + `.mcp.json` re-pointed off `.worktrees/restore-min` to the primary tree.
- Agent-server env pins restored (`27830c18`) — **opencode uses `environment`, Claude uses `env`**; wrong key silently no-ops.
- 4 competing resume docs consolidated to ONE `entrypoint/backlog/report/HANDOFF.md` (on `feat/backlog-hard-replacement`).
- All work pushed: 7 branches, every one `ahead=0`.

---

## 7. STILL TRUE / STILL OPEN (do not lose these)

- **`5b39e49b` (HIGH, UNTRIAGED)** — cross-process write-safety dedupe control reports **399/400 rows `ok:true` but NOT persisted**, reproducing across three runs. **Do NOT characterise as benign or as a bug without a `debug` triage.**
- **`280bfb3c` (CRITICAL, open)** — fresh CLI opens fail 5/5 while long-lived holders exist; `tshm.stale` files accumulate ~1 per 1.5 min independent of any holder.
- **`6603272a` staging decision** — no worktree-independent staging exists; the worktree-pinned fallback fails LIVE-2's DoD.
- `a7d3990a` — fix on branch `fix/apigen-cli-002-help-bracketing` @ `7e64fa65` (pushed); item still OPEN, transition once merged.
- `805de7d5` — its fix now lives **only** on `origin/burn/backlog-a`.
- **Filed this session:** `327870d9` · `5b39e49b` · `12cb976c` · `3f31cff4` · `f613472b` · `d5fb11c6` · `4fa74f99` · `e5e84710` · `5c51eeb6`.
- **Held back — NO citable evidence, do not treat as fact:** "renderer inert for 16/17 agents", "`bin/soxe` broken", "cross-process build/test isolation". Re-derive before filing.
- **`5b39e49b`-adjacent:** the operator restarted after this file was written — confirm `.mcp.json`/opencode config changes took effect (`/mcp` reload) and that the **backlog MCP is proven as a HOST** (only the *server* was proven: 18 tools, v1.0.0).

---

## 8. ENVIRONMENT HAZARDS — each cost real time to learn

- **`git push`**: use `</dev/null` **and never pipe its output** — piping silently broke a ref update once. `</dev/null` alone is **not** sufficient: a push still died SIGPIPE(141) and did not land, then succeeded on retry. **ALWAYS verify the remote tip with `git ls-remote` after pushing.**
- **`--no-verify` is deny-listed** for push. Pre-push runs `nx affected -t test` (~7.5 min).
- **zsh does not word-split an unquoted `$VAR`** — use literal args or an array. (This silently no-op'd a 13-PID kill.)
- **`git stash*` is deny-listed**, including the read-only `git stash list`.
- **Never** stock `sqlite3` against `~/.adhd/backlog/production/data/backlog-v2.db` — use `adhd-backlog`.
- **`rg --files` is gitignore-aware** — it cannot prove an absence under `dist/`.
- **`PPID==1` is NOT proof of an orphan** — hosts are `detached:true`+`unref()` **by design**. Require positive argv evidence. (Acting on `PPID==1` killed live infrastructure with a live client.)
- Never `--skip-nx-cache`; never invoke `tsc` directly.
- **`git push`, `git commit` and tool timeouts**: an agent's own 120 s timeout has SIGTERM'd a commit mid-gate. Use generous timeouts.

---

## 9. RECURRING FAILURE MODE TO AVOID (15 instances this session)

Every error was **validating a proxy instead of the condition**, or **treating a seam as the whole system**: `nx.json` for a project override · default `get` projection · a `view:` enum · a `truncated --help` · a branch **name** for tip-durability · paraphrasing a doc instead of reading it · `PPID==1` for orphanhood · a gitignore-aware tool to prove an absence · piping a push · generalising "every global" from two files · **querying the wrong system** (the `agent_*` tools are the **adhd `@adhd/agent-mcp`** server, NOT opencode's dispatcher — there is no opencode tool to enumerate its own subagents; use completion notifications + `ps`).

**Rule: verify the condition, at the real seam, then report.**
