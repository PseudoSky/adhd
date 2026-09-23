# PAUSE-STATE — backlog-v2 remediation @ 2026-09-23T05:05Z

Written on user "pause". Nothing in flight; machine load 6. Memory MCP was down (`backend unavailable`), so this is the durable resume point.

## Landed since the 22:15Z handoff (all verified)

- **PR #9 MERGED** — squash `545d7025` ("1.0.0 — one surface, one identity") on `origin/main`. PRs #10–12 merged earlier.
- **Embedding funnel**: implemented, teeth-proven, blind-reviewed (a HIGH caught + fixed), published (provider 0.5.2/0.5.3, service-proxy 0.4.1/0.4.2/0.4.3), deployed live, **embeddings re-enabled and verified** (semantic search exits 1.6s; 5 consumers → 1 host; self-reap ~30s; read-only verbs spawn zero).
- **Vector-write loss fixed live** (`257b146e`): the base's drain was dead code; a bounded 30s close-time drain now covers every producer. RED→GREEN proof: `auditTrail: ["created","embedding_upserted"]`.
- **Dedupe over-match fixed on the branch** (`90a4fc3a`): the hole was *superseded* rows (not invalidated); the shared filter fix also protects `view:similar`.
- **The 72-packet program**: 4 architects specced all remaining work (LIVE-1..11, EMBED-1..16, RSD-1..26, STORE-1..16 + WAVE-1..3) under `entrypoint/backlog/report/packets/`; a 5th architect produced **`SEQUENCE.md`** — 5 waves, **47 consolidated owner gates**, 10 gaps closed, 14 file-contention lanes.
- **Wave 0 DONE** (`fdae906f`): specs moved, 29 title-only bodies retrieved, LIVE-9 collapsed, two gate-hygiene reds closed with evidence.
- **RSD-15 spike closed as premise-FALSE** (`4a3caa9e` → invalid): every emit path `JSON.stringify`s correctly; the "~15% invalid JSON" was the scan merging stdout+stderr. Filed `3cfa32c0` (`ADHD_BACKLOG_LOG_LEVEL` never consumed).
- **LIVE-1 prep DONE**: clean build of `545d7025` in `.worktrees/backlog-release` (branch `release/backlog-1.0.0`; dist sha256 `a74a180e…`, 722,074 B, mode 755); `deploy-verify.sh` committed (`483fe47e`); rollback rehearsed (frozen RED 24–52s vs merged-main 1.53–2.86s; pointer restored exactly). **PR #13 OPEN + MERGEABLE** (`chore/backlog-post-merge-followups` — 5 post-squash commits + the adapted doc pointer).
- **Stalled server write path root-caused**: `startBacklogServer` freezes `ctx.env.config.embedding` at startup (`server.ts:776/842` vs `cli.ts:640`) + a silent member-less derive (`bootstrap.ts:256`) + the no-op gate (`embedding-observer.ts:148-149`). Filed `898e0bb2`, `0bc19f0f`, `205cd742`.
- **Coverage measured**: 15.08% of vectors missing (273/1810; 213 candidates; **growing**). The re-embed surface is documented-but-unreachable live (`6417df20`); the only working path is the dev-only `tools/etl/embed-backfill-cli.ts`. Filed `ce98c6c3`, `97c03dfd`, `287c301e`, `88b26235`, `87799e1d`, `2039bb80`, `1c9ed8da`, `f429e81f`, `9200ed9e`, `2f117762`, `acd4698e`, `6603272a`, `d293d54e`, `c75facbf`, `9926917c`, `1d57b8cb`.
- **sox fully pushed**: 49 commits + 13 release tags on `origin`.

## Pending (resume point)

1. **G1** — the config-freeze fix (the last live embedding defect). Next in the dispatch queue.
2. **The cutover (LIVE-2)** needs: (a) user approval to **publish `@adhd/backlog` 1.0.0** + the **machine-global re-points** (bin + `.mcp.json` + `~/.claude.json`); (b) the **`6603272a` staging decision** (no worktree-independent staging exists — `pnpm deploy` symlinks back + omits `@adhd/sox-*`; the fallback is worktree-pinned, which fails LIVE-2's DoD).
3. **PR #13** — user's merge call.
4. **Local `main` diverged from `origin/main`** — the primary tree lacks `.githooks/pre-push` and carries pre-1.0.0 content. **Do-not-build from local main** until reconciled (backup branch → `reset --soft origin/main` at a quiescent moment; never hard reset).
5. **`SEQUENCE.md` §6 — the 47 gates** are the user's decision pass (critical path for Wave 4).
6. Waves 1–3 per `SEQUENCE.md` (correctness/data-integrity → embedding-truth → surface/feature).
7. Small doc corrections queued: RSD-15's packet re-scope + `c75facbf` (the packet's false "already fixed" claim).

## Environment

- Load was ~258 (other sessions' vitest loops in `.worktrees/nx-perf-upgraded` + sox worktrees); now 6. My heavy work serialized throughout.
- A stray `rm: /Users/nix/dot/bin/node` error appears in nearly every shell invocation — **not** from my commands; an environment artifact worth investigating.
- Memory MCP: `backend unavailable` for most of the session (this file is the substitute).
- `gx` refuses from linked worktrees (index only covers the primary tree).
