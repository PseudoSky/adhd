# agent-search-cutover — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** merge-readiness · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

> **PREREQUISITE — human action required.** This state depends on `hb-release-decision` from `human-blockers.json`. Before starting, verify:
>
> ```bash
> python3 docs/plan/stealth-browser/scripts/guard.py merge-readiness --only merge-readiness.2
> ```
>
> If it fails, **halt this state as `blocked` (not `failed`) and surface the blocker to the human.** Do not work around it.

---

## Goal

The live agent-search MCP source keeps working while consuming `@adhd/stealth-browser`: the chrome-runner implementation is removed from agent-browser, the old barrel becomes a thin re-export, and a real MCP stdio client proves the server still serves chrome_status and list_providers.

---

## Semantic Distillation

- **Primitive:** MODIFY `/Users/nix/dev/ai/scratch/agent-browser/{adhd/,cdp-query-client.ts,search/queries/,package.json,search-mcp-source.ts}` (scratch repo, local-only).

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts`, `/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts:454-495`, `/Users/nix/dev/ai/scratch/agent-browser/server.mjs`, `/Users/nix/dev/ai/scratch/agent-browser/package.json`.

- **Delta Spec:** Preconditions are guarded (RELEASE-DECISION.md). In `/Users/nix/dev/ai/scratch/agent-browser`: add the dependency per the CONSUME line; delete `adhd/` (the runner), `search/queries/{activity,context}.ts`; make `cdp-query-client.ts` re-export from `@adhd/stealth-browser`; keep `getLastSearchFromHistory` and `last-search.ts` local; keep `getSearchSessionId` imports working via the alias. `search-mcp-source.ts` imports the six verbs' implementations from the package where they were local. Run `pnpm run build` and `pnpm run test:lifecycle`, then the stdio MCP probe in `guard.py agent-search-cutover`. Commit in the scratch repo LOCALLY (it is local-only: never push), explicit paths only, no PII.

- **Invariants:** [inv:scratch-local-only]; the live MCP server must keep serving; never stage unrelated agent-dashboard/claude-metadata changes that are already modified in that working tree. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:agent-search-cutover]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover` — runs every acceptance criterion below (red until the work is done); `--only agent-search-cutover.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover --only agent-search-cutover.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [agent-search-cutover.1] Preconditions: RELEASE-DECISION.md has `DECISION: publish|defer` and a `CONSUME:` line (`@adhd/stealth-browser@<version>` when published, `link:<abs path>` into the MERGED main checkout when deferred) and agent-browser/node_modules resolves @adhd/stealth-browser.

- [agent-search-cutover.2] The chrome-runner implementation is GONE from agent-search: no `class CdpSession`, `class ChromeManager`, `class IdleShutdown` or `class HistoryClient` definition remains under agent-browser (thin consumer/shims only).
- [agent-search-cutover.3] agent-browser still compiles: `pnpm run build` (tsc --noEmit) exits 0 and `pnpm run test:lifecycle` exits 0 against @adhd/stealth-browser.
- [agent-search-cutover.4] The live MCP server still works through a REAL MCP stdio client: `node server.mjs` lists the search tools and chrome_status + list_providers return structured results.
- [agent-search-cutover.5] Scratch repo hygiene: cutover commits are local-only (no push/upstream), staged by explicit path, and touch only agent-browser/adhd/, cdp-query-client.ts, search/queries/, package.json and the cutover docs.
- [agent-search-cutover.6] (D3) Before consumption: a link: CONSUME target has a built dist (dist/index.js, dist/bin/cli.js, dist/bin/mcp.js) and `node dist/bin/cli.js --help` exits 0 there; agent-browser's node_modules/@adhd/stealth-browser/package.json exists.
---

## Reservations

```text
read_only:  []
mutates:    ["/Users/nix/dev/ai/scratch/agent-browser/adhd/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/", "/Users/nix/dev/ai/scratch/agent-browser/package.json", "/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts"]
```

---

## Contract Promise

Modified: agent-browser sources and package.json. Deleted: `adhd/`, two query files.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:agent-search-cutover]`:

- [ ] After the dependency is installed and the build is green -- commit: `refactor(agent-browser): consume @adhd/stealth-browser [psm:agent-search-cutover]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The scratch working tree is already dirty with other projects' edits: stage by explicit path only.
- If the stdio probe fails, restore with `git restore` on the touched paths from the previous commit; do not leave the live MCP source broken.
