# search-cutover — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** search-usecases, search-examples, tracing-log-validation, tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-cutover`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The scratch agent-search project is replaced by the unreleased build, proven before the audit: tarballs of the three packages (tripwire, core, search) packed from THIS worktree install as real directories in a scratch temp consumer, behave exactly as the old tool did (provider ids, tripwire block), and the retired `agent-browser/` project, its bins and its policy references are removed. This is the integration proof that stands in for e2e (user decision).

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/evidence/cutover/{before,tarballs,consumer,parity,removal,backlog}.json` and `evidence/cutover/live-vs-recorded.md`; DELETE (scratch repo, explicit paths) `/Users/nix/dev/ai/scratch/agent-browser/`'s authored files, `bin/scratch-agent-search*`; MODIFY `/Users/nix/dev/ai/scratch/docs/GIT-POLICY.md` (references only).

- **Reference Pattern:** SPEC-stealth-search.md sections 3 (end state) and 6.1 ([ref:stealth-search-spec]); `evidence/tripwire/tripwire-tarball.json` (tarball record shape); the retired `agent-search-cutover` contract.

- **Delta Spec:** (1) BEFORE any scratch change capture `evidence/cutover/before.json` (`captured_at_epoch`, the 12 `provider_ids`, `help_keys`, the old MCP `tools` via a real stdio client on `node server.mjs --transport stdio`, `legacy_lock`: a seeded legacy lock blocks a search with outcome `hitl`, zero Chrome calls) and commit it. (2) `pnpm pack` the three built packages in order tripwire, core, search into a directory OUTSIDE every `.worktrees/` (`/Users/nix/.cache/adhd-dev-tarballs/`); record `evidence/cutover/tarballs.json` `{order:['tripwire','core','search'], packages:{<key>:{tarball,sha256,packed_from_head,packed_from_tree,pack_cmd}}}`. (3) Create a temp consumer outside every repository, install the three tarballs as real directories (no `link:`, `file:`, symlink or `.worktrees` value in any committed file), record `evidence/cutover/consumer.json {consumer_dir}`. (4) From the consumer run the installed `stealth-search` CLI and `stealth-search-mcp` and record `evidence/cutover/parity.json {before, after}` (`after`: `provider_ids`, `tools` = the eleven `stealth_*` names, `legacy_lock` with the namespace carried by the seeded lock, accepted per O8). (5) Write `live-vs-recorded.md` with `LIVE:`, `RECORDED:` (ranges `^0.1.0`, resolve only once released) and `NOT-CHANGED:` lines naming the three sha256 values and the lockfiles. (6) Remove the scratch project: `agent-browser/` authored files (listed in `removal.json`), `bin/scratch-agent-search*`, and fix `docs/GIT-POLICY.md` references; commit in the scratch repo by explicit path, local-only, `[psm:search-cutover]`. `INDEX.md` and `agent-browser/metrics.json` carry another agent's uncommitted work: never touch or stage them. (7) Through the backlog graph (never a hand edit) resolve or supersede B-028..B-035 and 19dfb641 with a citation, record in `evidence/cutover/backlog.json`.

- **Invariants:** [inv:scratch-local-only] [inv:cutover-live-vs-recorded] [inv:source-untouched] (until your first commit) [inv:no-main-writes] [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-cutover]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-cutover` runs every acceptance criterion below (red until the work is done); `--only search-cutover.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-cutover --only search-cutover.N`, loaded from `scripts/guards/search_b.py`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-cutover.1] `before` is captured before any scratch change: evidence/cutover/before.json records the twelve provider ids, the help keys of listProviders, the old MCP tool list, a seeded legacy lock that blocks a search with outcome hitl and zero Chrome calls, and a captured_at earlier than the first [psm:search-cutover] commit in the scratch repo.
- [search-cutover.2] The packages under test are the ones built from THIS worktree, in dependency order tripwire, stealth-core-browser, stealth-search: evidence/cutover/tarballs.json records for each a `tarball` outside every .worktrees/ directory, its `sha256` (equal to the file's), `packed_from_head` (an ancestor of HEAD), `packed_from_tree` (equal to that package's tree at that commit) and the pack_cmd; each tarball lists its dist/index.js and the search tarball also package/dist/bin/cli.js and package/dist/bin/mcp.js.
- [search-cutover.3] The proof consumer is a scratch temp project outside every repository and .worktrees/ (evidence/cutover/consumer.json: consumer_dir) whose node_modules/@adhd/{resilience-core-tripwire,stealth-core-browser,stealth-search} are real directories (not symlinks) with dist/index.js byte-identical to the recorded tarball's member, and no committed file carries a link:/file:/.worktrees value for them.
- [search-cutover.4] evidence/cutover/live-vs-recorded.md states precisely what is LIVE and what is only RECORDED: a `LIVE:` line (the consumer node_modules content = the three tarballs, with all three sha256 values), a `RECORDED:` line (the dependency ranges of the three packages ^0.1.0, which resolve only once released) and a `NOT-CHANGED:` line naming pnpm-lock.yaml of the adhd checkout; the adhd main checkout's pnpm-lock.yaml is unmodified.
- [search-cutover.5] Behaviour parity through the installed packages: evidence/cutover/parity.json has `before` and `after`; after.provider_ids equals before.provider_ids (twelve), after.tools is the eleven stealth_* names, the seeded legacy lock still blocks a search with outcome hitl and zero Chrome calls, and a live re-run of the installed consumer's `stealth-search-mcp --transport stdio` returns the same tool names as `after`.
- [search-cutover.6] The scratch agent-browser project is gone: evidence/cutover/removal.json lists every removed path and none of the authored runner paths remains under /Users/nix/dev/ai/scratch/agent-browser (adhd/, server.mjs, search-cli.mjs, cdp-search.ts, search-mcp-source.ts, search-providers.ts, search-guard.ts, search-tripwire.ts, search-fetch.ts, fetch-policy.ts, apigen-client-common.mjs), the bin/scratch-agent-search* shims are removed, and docs/GIT-POLICY.md no longer references them.
- [search-cutover.7] Scratch hygiene: at least one [psm:search-cutover] commit exists in the scratch repo, they are local-only (the branch has no upstream containing them), each touches only agent-browser/, bin/scratch-agent-search* and docs/GIT-POLICY.md, and none touches INDEX.md or agent-browser/metrics.json (another agent's uncommitted work).
- [search-cutover.8] Backlog findings of the retired project are dispositioned through the graph (never a hand edit of BACKLOG.md): evidence/cutover/backlog.json has an entry for each of B-028..B-035 and 19dfb641 with `id`, `status` (resolved|closed|superseded) and a `citation` naming the stealth-search or core path that supersedes it.
- [search-cutover.9] No lockfile moved: [psm:search-cutover] commits in the adhd worktree do not touch pnpm-lock.yaml, and the edits to the retired project's tracked package.json left no `@adhd/` dependency behind (the project is deleted).
- [search-cutover.10] Only owned paths changed by [psm:search-cutover] commits in the adhd worktree (the evidence/cutover/ files).

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/evidence/source-baseline.txt"]
mutates:    ["docs/plan/stealth-browser/evidence/cutover/", "/Users/nix/dev/ai/scratch/agent-browser/", "/Users/nix/dev/ai/scratch/bin/scratch-agent-search", "/Users/nix/dev/ai/scratch/bin/scratch-agent-search-serve", "/Users/nix/dev/ai/scratch/bin/scratch-agent-search-mcp-cli", "/Users/nix/dev/ai/scratch/docs/GIT-POLICY.md"]
```

---

## Contract Promise

Added: the cutover evidence files. Deleted: the scratch `agent-browser/` authored files and the three `bin/scratch-agent-search*` shims. Modified: `docs/GIT-POLICY.md` references (scratch repo).

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-cutover]`:

- [ ] Evidence of the `before` shape (plan repo) — commit: `chore(stealth-browser): cutover baseline shape [psm:search-cutover]`
- [ ] Scratch removal (scratch repo, explicit paths) — commit: `refactor(agent-browser): retire in favour of @adhd/stealth-search [psm:search-cutover]`
- [ ] Tarball, parity and live-vs-recorded evidence (plan repo) — commit: `chore(stealth-browser): cutover proof [psm:search-cutover]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Never `git add -A` in the scratch repo; never push; adhd lockfile untouched (`.9`). The tripwire namespace changes `agent-search` -> `stealth-search` (O8): record in `parity.json` how `after` treats the seeded legacy lock. Real consumers are `consumer-relink`'s.
- NAMING: shared text names `evidence/split/cutover-live-vs-recorded.md`; this state writes `evidence/cutover/live-vs-recorded.md` (own directory, disjoint from `core-scaffold`).
