# agent-search-cutover — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** tests-use-cases · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

agent-search runs on the new package, proven before the audit: the package built from THIS worktree is packed into a tarball and installed into agent-browser, the 14 consumer files import only the package root, the in-repo runner copy is gone, agent-browser builds and passes its lifecycle test, and the MCP search verbs behave exactly as before through a real MCP stdio transport. The note of what is live and what is only recorded is written down precisely. This is the integration proof that stands in for e2e (user decision).

---

## Semantic Distillation

- **Primitive:** MODIFY the owned agent-browser consumer files in `/Users/nix/dev/ai/scratch/agent-browser` (`cdp-query-client.ts`, `cdp-search.ts`, `chrome-lifecycle-test.ts`, `network-capture.ts`, `search-challenge.ts`, `search-dom.ts`, `search-fetch.ts`, `search-guard-test.ts`, `search-mcp-source.ts`, `search-network.ts`, `search-tripwire.ts`, `search/queries/{activity,context,last-search}.ts`), `package.json`, docs; DELETE `agent-browser/adhd/`; CREATE `evidence/cutover-tarball.json`, `evidence/cutover-parity.json`, `evidence/cutover-live-vs-recorded.md`. CREATE `evidence/cutover-backlog.json`.

- **Reference Pattern:** `README.md` (Source package after migration), `scripts/port-manifest.json` (exports to map), `search-mcp-source.ts` (`chromeStatus`, `launchChrome`, `shutdownSearchChrome` call sites), `server.mjs` (defaults to SSE; `--transport stdio` or SEARCH_MCP_TRANSPORT=stdio selects stdio).

- **Delta Spec:** (1) BEFORE the first change, capture `before` in `evidence/cutover-parity.json`: run `node server.mjs --transport stdio` through a real MCP stdio client and record the tool-name list plus the sorted result keys of `chrome_status` and `list_providers`. (2) Build the package (`nx run stealth-browser:build` and `:build-bin`), `npm pack` the built dist into a tarball stored OUTSIDE every `.worktrees/` directory, record `evidence/cutover-tarball.json` (`tarball`, `sha256`, `packed_from_head`, `packed_from_tree`, `pack_cmd`). (3) Install the tarball into agent-browser's node_modules as a real directory (no symlink, no `link:`/`file:`, no `.worktrees` path in any committed file); the committed `package.json` records the dependency range, which resolves only once the package is released, and `pnpm-lock.yaml` is NOT changed. (4) Rewrite every consumer file that imported `./adhd/...` to import `@adhd/stealth-browser` (root only; names are root exports: namespaces, verbs, types); `getPageContext` takes a `targetId`; the greenfield names apply (`PageSource`, no `getSearchSessionId`). (5) Delete `agent-browser/adhd/`; the root `network-capture.ts` delegates to `captureNetworkResponse` (its `#rso` preference becomes the `select` option) and drops its own WebSocket; `search-mcp-source.ts` delegates Chrome lifecycle to the package per the chrome-lifecycle design; no existing option (including `checkHistory`) is removed. (6) `pnpm run build` and `pnpm run test:lifecycle` exit 0. (7) Capture `after` and prove it equals `before`. (8) Write `evidence/cutover-live-vs-recorded.md` with `LIVE:`, `RECORDED:` and `NOT-CHANGED:` lines naming the tarball sha, the package.json range and both lockfiles. (9) Through the backlog graph (never a hand edit of BACKLOG.md) resolve B-028..B-033, the stale B-034 / B-035 rows (fixed in fd627f5) and 19dfb641 (re-cited to the new package paths; chrome-lifecycle is verified), and record them in `evidence/cutover-backlog.json`.

- **Invariants:** [inv:scratch-local-only] [inv:cutover-live-vs-recorded] [inv:source-untouched] (until your first commit) [inv:no-main-writes] [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:agent-search-cutover]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover` — runs every acceptance criterion below (red until the work is done); `--only agent-search-cutover.N` runs one. The post-release `link:`/published consumption is the separate dispatcher-gated state `agent-search-relink`.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover --only agent-search-cutover.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [agent-search-cutover.1] The package under test is the one built from THIS worktree: evidence/cutover-tarball.json records `tarball` (an absolute path outside every .worktrees/ directory), its `sha256`, `packed_from_head` (a commit that is an ancestor of HEAD) and `packed_from_tree` (the entrypoint/stealth-browser tree sha at that commit), the `pack_cmd` (pack of the built dist) and the tarball lists package/dist/index.js, package/dist/bin/cli.js and package/dist/bin/mcp.js.
- [agent-search-cutover.2] The live agent-browser install IS that tarball: agent-browser/node_modules/@adhd/stealth-browser is a real directory (not a symlink, not a link into .worktrees/), its package.json version equals the tarball's, and its dist/index.js is byte-identical to the tarball's member.
- [agent-search-cutover.3] evidence/cutover-live-vs-recorded.md states precisely what is LIVE and what is only RECORDED: lines `LIVE:` (node_modules content = the tarball, with its sha256), `RECORDED:` (the committed agent-browser/package.json dependency range, which resolves only once released) and `NOT-CHANGED:` naming pnpm-lock.yaml in agent-browser and the adhd main checkout's pnpm-lock.yaml; agent-browser/package.json carries no `link:`/`file:` value and no .worktrees path, and the adhd main checkout lockfile is unmodified.
- [agent-search-cutover.4] The chrome-runner implementation is GONE from agent-search: no `class CdpSession`, `class ChromeManager`, `class IdleShutdown` or `class HistoryClient` definition remains under agent-browser (thin consumer only).
- [agent-search-cutover.5] agent-browser still compiles against the installed tarball: `pnpm run build` (tsc --noEmit) exits 0 and `pnpm run test:lifecycle` exits 0.
- [agent-search-cutover.6] The MCP search verbs behave the same through a REAL transport: evidence/cutover-parity.json holds `before` (captured from the unmodified server before the first cutover commit) and `after` shapes of `node server.mjs --transport stdio` (the server defaults to SSE, so stdio is named): identical tool-name lists and identical result-key shapes for chrome_status and list_providers; `after` equals a live re-run now.
- [agent-search-cutover.7] Scratch repo hygiene: cutover commits are local-only (no push/upstream), staged by explicit path (never `git add -A`: the scratch tree carries other agents' uncommitted work), and touch only the owned consumer files (agent-browser/adhd/, the ~14 files that imported ./adhd/..., package.json and the cutover docs); INDEX.md and pnpm-lock.yaml are not touched before release.
- [agent-search-cutover.8] (amendment A5) agent-search delegates to the new capture and the package lifecycle: the root network-capture.ts calls `captureNetworkResponse` from @adhd/stealth-browser (its `#rso` preference expressed through the `select` option) and contains no `new WebSocket(`; search-mcp-source.ts delegates Chrome lifecycle to the package as defined by the chrome-lifecycle design (EVALUATIONS.md).
- [agent-search-cutover.9] (amendment A5) evidence/cutover-backlog.json records, through the backlog graph (never a hand edit of BACKLOG.md), the agent-browser findings B-028..B-033 as resolved, the stale B-034 / B-035 rows as resolved or closed (fixed in fd627f5), and backlog 19dfb641 re-cited to the new package paths and resolved once chrome-lifecycle is verified; each entry has an `id`, a `status` and a `commit` or `citation`.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/", "docs/plan/stealth-browser/scripts/port-manifest.json"]
mutates:    ["/Users/nix/dev/ai/scratch/agent-browser/adhd/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts", "/Users/nix/dev/ai/scratch/agent-browser/cdp-search.ts", "/Users/nix/dev/ai/scratch/agent-browser/chrome-lifecycle-test.ts", "/Users/nix/dev/ai/scratch/agent-browser/network-capture.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-challenge.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-dom.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-fetch.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-guard-test.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-network.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-tripwire.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/activity.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/context.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/last-search.ts", "/Users/nix/dev/ai/scratch/agent-browser/package.json", "/Users/nix/dev/ai/scratch/agent-browser/AGENTS.md", "/Users/nix/dev/ai/scratch/agent-browser/SEARCH.md", "/Users/nix/dev/ai/scratch/agent-browser/FEATURES.md", "/Users/nix/dev/ai/scratch/agent-browser/FETCH.md", "/Users/nix/dev/ai/scratch/agent-browser/docs/", "/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/evidence/"]
```

---

## Contract Promise

Modified: the owned agent-browser consumer files, `package.json`. Added: the three cutover evidence files. Deleted: `agent-browser/adhd/`. The scratch repo working tree carries other projects' uncommitted edits: stage by explicit path, never push, never touch `INDEX.md` (it holds other agents' uncommitted work).

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:agent-search-cutover]`:

- [ ] Evidence of the `before` shape — commit (plan repo): `chore(stealth-browser): cutover baseline shape [psm:agent-search-cutover]`
- [ ] Consumer rewrite + adhd/ deletion (scratch repo, by explicit path) — commit: `refactor(agent-browser): consume @adhd/stealth-browser [psm:agent-search-cutover]`
- [ ] Tarball, parity and live-vs-recorded evidence (plan repo) — commit: `chore(stealth-browser): cutover proof [psm:agent-search-cutover]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- This state replaces the e2e lane: it is the proof against a real consumer.
- Never `git add -A` in the scratch repo.
- `INDEX.md` in the scratch root stays untouched (another agent's uncommitted edits would be swept into your commit); the entry update is tracked in `DEFERRED.md`.
