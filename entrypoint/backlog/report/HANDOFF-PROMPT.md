# HANDOFF PROMPT — complete the backlog-v2 remediation

Paste the block below into a fresh agent session. It is self-contained; the artifacts it names live beside this file.

---

````
# MISSION
Complete the backlog-v2 remediation in /Users/nix/dev/node/adhd. The 1.0.0 replacement is merged to
main; finish the deploy (cutover), close the last live defect, and execute the remaining work program
to done.

# READ FIRST, IN ORDER
1. `.worktrees/backlog-v2/entrypoint/backlog/report/PAUSE-STATE.md` — the state of record (05:05Z).
2. `.worktrees/backlog-v2/entrypoint/backlog/report/packets/SEQUENCE.md` — the 5-wave plan, the
   consolidated 47 owner gates (§6), 14 file-contention lanes, 10 closed gaps.
3. The four packet files beside it (`1-live-deploy-ci.md`, `2-embedding-semantic.md`,
   `3-registry-surface-data.md`, `4-store-criticals-waves.md`) + `title-only-bodies.md`.
4. The specs in the same `report/`: `registry-surface-redesign.md`,
   `citation-component-linking.md`, `deferral-cleanup-plan.md`, `embed-durability-fix-spec.md`,
   `wave-3a-semantic-adoption-spec.md`.

# STATE (verified 2026-09-23T05:05Z — re-verify anything you rely on)
- `origin/main` = `545d7025` (PR #9 squash-merged: "1.0.0 — one surface, one identity"). PRs #10–12
  merged earlier. **Local `main` is DIVERGED — do not build from it** (lacks `.githooks/pre-push`,
  carries pre-1.0.0 content; reconcile only with the user, never a hard reset).
- LIVE = `.worktrees/restore-min` (hand-port, `fix/live-restore` @ `257b146e`). Every pointer
  (`.mcp.json`, `~/.claude.json`, the pnpm shim, the nvm/pnpm symlinks) targets it.
- Embeddings are LIVE via the peer-spawned funnel (provider 0.5.3 / service-proxy 0.4.3): one host
  per machine, self-reaping, read-only verbs spawn zero. Coverage: 15.08% of vectors missing and
  growing; the server-side config freeze (`898e0bb2`) is the last live embedding defect.
- `.worktrees/backlog-release` = a clean build of `545d7025` (dist sha256 `a74a180e…`, mode 755);
  `deploy-verify.sh` (`483fe47e`) proves the cutover assertions incl. the negative control.
- **PR #13** (`chore/backlog-post-merge-followups`) OPEN + MERGEABLE — the post-squash commits.

# COMPLETION TARGET (what "done" means)
1. **Cutover (LIVE-2):** production runs the merged-main build from a **worktree-independent**
   release; the `restore-min` hand-port is retired; publish `@adhd/backlog` 1.0.0; re-point bin +
   `.mcp.json` + `~/.claude.json`; rollback documented and rehearsed.
2. **G1:** fix the config freeze (server must observe a config flip — config-fingerprinted cache or
   an on-open detect+backfill), make member-less LOUD when enabled, delete the dead
   `enableSemanticSearchFromConfig` calls; prove it RED/GREEN (start disabled → flip → MCP-create
   asserts no audit row; restart → asserts it appears).
3. **Waves 1–3 per SEQUENCE.md**, respecting its file lanes and the one-heavy-task-at-a-time rule.
4. **The 47 gates:** walk the user through §6 top-down; clear what they approve; proceed with the
   rest. Decision-gated packets are marked; start from the ungated set.
5. **Closers:** PR #13 merged; the RSD-15 packet re-scope + `c75facbf` correction; the local-main
   reconciliation (user-approved); branch/worktree cleanup; the CHANGELOG entries.

# ASK THE USER — never assume
- Approval to publish `@adhd/backlog` 1.0.0 and to make the machine-global re-points.
- The `6603272a` staging call (no worktree-independent staging exists today; the worktree-pinned
  fallback fails LIVE-2's DoD).
- The 47 gates; the local-main reconciliation.

# STANDING DIRECTIVES (non-negotiable)
- No push without approval (per-session grants only); no destructive git (never `reset --hard`,
  `stash`, `clean -f`); commits `--no-verify`; backload testing (targeted sweeps; the full affected
  gate once before a merge).
- NO managed service for embedding — the funnel is peer-spawned, unsupervised, self-reaping; NEVER
  call it a "daemon". ADR-0013: typed config, never env toggles.
- Live-testing policy (AGENTS.md §7): gates only for paid/external services, documented in README +
  AGENTS.md + the test header with a named owner.
- Backlog items ONLY via the `adhd-backlog` CLI (never hand-edit BACKLOG.md); the store is
  PRODUCTION — backup-first for any repair; file every bug/deferral at discovery; never declare
  anything "pre-existing"; verify state-side (git/tests/store), never trust a summary; end every
  response with the unacknowledged bugs/deferrals list.

# ENVIRONMENT
- Memory MCP may be down (`backend unavailable`) — retry; the disk handoff is authoritative.
- `gx` refuses from linked worktrees (the index covers the primary tree only).
- Pre-push flakes under load (`2f117762`); `git push --no-verify` is machine-denied — prefer a quiet
  window; `acd4698e` covers the worktree-hook gap.
- A stray `rm: /Users/nix/dot/bin/node` error appears in most shell invocations — not from your
  commands; flag it, don't chase it.
````
