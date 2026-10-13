# agent-search-relink — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** merge-readiness · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-relink`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

After the package is merged (and published or deferred) the dispatcher gates the second step: agent-browser consumes the released package or a `link:` into the MERGED main checkout, never a worktree, with its lockfile updated and the same MCP behaviour proven again.

---

## Semantic Distillation

- **Primitive:** MODIFY `/Users/nix/dev/ai/scratch/agent-browser/package.json` and `/Users/nix/dev/ai/scratch/agent-browser/pnpm-lock.yaml` (and the cutover docs); no consumer source changes.

- **Reference Pattern:** `RELEASE-DECISION.md` (DECISION, CONSUME, MAIN_BUILD lines), `evidence/cutover-parity.json` (the `after` shape), `merge-readiness`.

- **Delta Spec:** Read `CONSUME:` from `RELEASE-DECISION.md`: `@adhd/stealth-browser@<version>` when published, `link:<abs path>` into the merged main checkout when deferred (dist built there per `MAIN_BUILD`). Set the dependency accordingly, run `pnpm install`, then `pnpm run build`, `pnpm run test:lifecycle` and the live MCP shape check against the cutover `after` shape.

- **Invariants:** [inv:scratch-local-only] [inv:cutover-live-vs-recorded] [inv:no-main-writes]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:agent-search-relink]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-relink` — runs every acceptance criterion below (red until the work is done); `--only agent-search-relink.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py agent-search-relink --only agent-search-relink.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [agent-search-relink.1] Post-merge second step: RELEASE-DECISION.md has `DECISION: publish|defer` and a `CONSUME:` line (`@adhd/stealth-browser@<version>` when published, `link:<abs path>` into the MERGED main checkout when deferred; never a .worktrees path) and agent-browser/package.json depends on it.
- [agent-search-relink.2] (D3) Before relinking: a link: CONSUME target has a built dist (dist/index.js, dist/bin/cli.js, dist/bin/mcp.js) and `node dist/bin/cli.js --help` exits 0 there; agent-browser's node_modules/@adhd/stealth-browser/package.json resolves.
- [agent-search-relink.3] agent-browser builds and passes `pnpm run test:lifecycle` against the released/linked package, and the live MCP stdio shape still equals the cutover `after` shape in evidence/cutover-parity.json.
- [agent-search-relink.4] Scratch hygiene for the relink: [psm:agent-search-relink] commits are local-only, staged by explicit path, and touch only agent-browser/package.json, agent-browser/pnpm-lock.yaml and the cutover docs.
- [agent-search-relink.5] The tripwire dependency moves from the tarball to the registry range: agent-browser/package.json keeps `@adhd/resilience-core-tripwire` at `^0.1.0` (no link:/file:), agent-browser/pnpm-lock.yaml resolves it with an integrity hash and no tarball or file resolution, node_modules/@adhd/resilience-core-tripwire/package.json resolves, and `pnpm run test` (with a scratch SEARCH_ADHD_DATA_DIR) exits 0 against the registry build.

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/RELEASE-DECISION.md", "docs/plan/stealth-browser/evidence/cutover-parity.json"]
mutates:    ["/Users/nix/dev/ai/scratch/agent-browser/package.json", "/Users/nix/dev/ai/scratch/agent-browser/pnpm-lock.yaml", "/Users/nix/dev/ai/scratch/agent-browser/AGENTS.md", "/Users/nix/dev/ai/scratch/agent-browser/docs/", "/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/evidence/"]
```

---

## Contract Promise

Modified: agent-browser `package.json`, `pnpm-lock.yaml`. Added: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:agent-search-relink]`:

- [ ] Relink (scratch repo, by explicit path) — commit: `chore(agent-browser): consume the released @adhd/stealth-browser [psm:agent-search-relink]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Blocked on the human/dispatcher release decision (`hb-release-decision`).
- Never a `.worktrees` path in any committed value.
- The relink also switches `@adhd/resilience-core-tripwire` from the packed tarball to the registry range `^0.1.0` (agent-search-relink.5): `pnpm-lock.yaml` resolves it with an integrity hash and no tarball resolution. The reverse-apis consumer is relinked by the separate state `tripwire-reverse-relink`.
