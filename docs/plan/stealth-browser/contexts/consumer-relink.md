# consumer-relink — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** merge-readiness · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py consumer-relink`
**Executor:** `typescript-pro` (sonnet/medium); dispatcher-gated · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

After the three packages are published in dependency order (tripwire, stealth-core-browser, stealth-search), every consumer of the old `mcp__search__agent_browser_search_mcp_source_*` tools switches to the published package: agent definitions, the opencode `search` server entry and the sox-ecosystem references, with each consumer repo's own gates green.

---

## Semantic Distillation

- **Primitive:** MODIFY (explicit path, consumer repos outside this worktree): `~/.claude/agents/{researcher,product,performance,doc-evangelist}.md`, `~/.config/opencode/agents/{researcher,doc-evangelist}.md`, `~/.config/opencode/DOC-TRIO.md`, the opencode config `search` server entry, and in sox-ecosystem `extensions/agents/{researcher,performance,product,doc-evangelist}/` (+ `researcher/agent.md`, `CHANGELOG.md`), `libs/host-registry/{README.md,src/agent-renderers.spec.ts,src/agent-manifests.shell-policy.spec.ts}`, `tools/test-c1b17653-researcher-single-definition.mjs`; CREATE `docs/plan/stealth-browser/evidence/relink/*.json`.

- **Reference Pattern:** SPEC-stealth-search.md section 6.2-6.3 and O1/O3 ([ref:stealth-search-spec]); `RELEASE-DECISION.md`; `evidence/naming-decision.md` (the eleven tool names).

- **Delta Spec:** (1) Record `evidence/relink/publish-order.json {order:[tripwire, core, search package names], published:{<pkg>:<version>}, verified_at}` after `npm view` confirms each; (2) the dispatcher approves (`dispatcher-approval.json {approved_by, approved_at, repos}`); (3) re-run `rg -l agent_browser_search_mcp_source` over the three roots to build `consumers.json` (`[{path, repo, status:'relinked', commit|null}]`, a directory path covers its files), then replace the old tool names with `mcp__search__stealth_*` (names from `naming-decision.md`; no alias, no both-names period) and set the opencode `search` entry to run `npx -y @adhd/stealth-search stealth-search-mcp` (stdio) or the `--transport sse` daemon URL; (4) run each consumer repo's own gates (sox-ecosystem: the `c1b17653` single-definition tool and the host-registry specs) and record them in `consumer-gates.json {repos:[{repo, commands:[{cmd, exit}]}]}`; (5) prove the published package answers: the npx command lists the eleven tools.

- **Invariants:** [inv:cutover-live-vs-recorded] [inv:greenfield] [inv:no-main-writes]. Edits in other repositories are explicit-path only; commit each in its own repository with no AI attribution; never revert another agent's work. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:consumer-relink]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py consumer-relink` runs every acceptance criterion below (red until the work is done); `--only consumer-relink.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py consumer-relink --only consumer-relink.N`, loaded from `scripts/guards/search_b.py`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [consumer-relink.1] Publish order is proven: evidence/relink/publish-order.json has order [@adhd/resilience-core-tripwire, @adhd/stealth-core-browser, @adhd/stealth-search] and published versions for all three (>= 0.1.0), each confirmed live by `npm view <pkg>@<version> version` now; RELEASE-DECISION.md records DECISION: publish for each of the three packages.
- [consumer-relink.2] The relink is dispatcher-gated: evidence/relink/dispatcher-approval.json records approved_by (dispatcher or human), an ISO timestamp, the repos in scope and that approval came after the publish check (approved_at later than publish-order.json verified_at).
- [consumer-relink.3] evidence/relink/consumers.json inventories EVERY consumer of the old tool names: the six home agent files (~/.claude/agents researcher, product, performance, doc-evangelist; ~/.config/opencode/agents researcher, doc-evangelist), ~/.config/opencode/DOC-TRIO.md, the opencode `search` server entry, and in sox-ecosystem extensions/agents/{researcher,performance,product,doc-evangelist}/, researcher/agent.md, libs/host-registry/{README.md,src/agent-renderers.spec.ts,src/agent-manifests.shell-policy.spec.ts} and tools/test-c1b17653-researcher-single-definition.mjs, each with status relinked and a commit (or null when the file is not in a repository).
- [consumer-relink.4] No consumer still names the retired tools: none of the inventoried files nor anything under ~/.claude/agents, ~/.config/opencode matches `agent_browser_search_mcp_source`, and the files that allow the search tools use `mcp__search__stealth_*` names that are all among the eleven MCP-NAMES of naming-decision.md.
- [consumer-relink.5] The opencode `search` MCP server entry runs the published package: ~/.config/opencode config has an entry named search whose command runs `@adhd/stealth-search` / `stealth-search-mcp` (stdio) or whose url targets the daemon started with `--transport sse`, and no longer the retired `http://127.0.0.1:3100/sse` agent-search endpoint.
- [consumer-relink.6] The published package answers as the configured entry does: `npx -y -p @adhd/stealth-search stealth-search-mcp --transport stdio` (scratch HOME) lists the eleven stealth_* tools of naming-decision.md through a real MCP stdio client.
- [consumer-relink.7] The consumer repos' own gates are green and recorded: evidence/relink/consumer-gates.json has, for sox-ecosystem, commands (including node tools/test-c1b17653-researcher-single-definition.mjs and the host-registry specs) each with exit 0, run after the edits, and one entry per other edited repository.
- [consumer-relink.8] Edits in other repositories are explicit-path and only to inventoried files: every consumers.json commit exists in its repository (git cat-file), touches only inventoried paths of that repo, and no commit message carries an AI attribution trailer.
- [consumer-relink.9] Only owned paths changed by [psm:consumer-relink] commits in the adhd worktree (evidence/relink/).

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/RELEASE-DECISION.md", "docs/plan/stealth-browser/evidence/naming-decision.md"]
mutates:    ["docs/plan/stealth-browser/evidence/relink/", "/Users/nix/.claude/agents/", "/Users/nix/.config/opencode/", "/Users/nix/dev/ai/sox-ecosystem/extensions/agents/", "/Users/nix/dev/ai/sox-ecosystem/libs/host-registry/", "/Users/nix/dev/ai/sox-ecosystem/tools/test-c1b17653-researcher-single-definition.mjs", "/Users/nix/dev/ai/sox-ecosystem/docs/guidelines/authoring.md", "/Users/nix/dev/ai/sox-ecosystem/docs/spec/cross-platform-install-rendering.md"]
```

---

## Contract Promise

Added: `evidence/relink/*.json`. Modified: the consumer files above in their own repositories. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:consumer-relink]`:

- [ ] Per consumer repository (explicit paths) — commit: `chore: use @adhd/stealth-search tools [psm:consumer-relink]`
- [ ] Evidence (plan repo) — commit: `chore(stealth-browser): relink evidence [psm:consumer-relink]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Blocked until publish (`hb-sp-release` resolved, PUBLISHING.md per-project tasks, published-state.json committed) and the dispatcher gate; the order is load-bearing: stealth-search's dist manifest resolves its internal ranges from npm.
- Dispatch per repository with its own gates; do not stage unrelated dirty files in any consumer repo.
- Files that are not in a git repository (home dotfiles) are recorded with `commit: null`.
