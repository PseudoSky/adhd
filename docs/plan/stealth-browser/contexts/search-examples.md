# search-examples — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** search-hosts · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-examples`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Every example a reader can copy is real: runnable examples exist for all eleven operations, every README code block is listed in a manifest and verified by a unit test, and every CLI command line in the README names real operations and flags.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/examples/*.ts`, `entrypoint/stealth-search/examples/manifest.json`, `entrypoint/stealth-search/src/test/unit/examples/*.spec.ts`; MODIFY `entrypoint/stealth-search/README.md` (code blocks and their order only; the narrative rewrite belongs to `readme-rewrite`).

- **Reference Pattern:** `PLAN/contexts/prod-examples.md` (the core's example discipline), `entrypoint/backlog/README.md` (host examples).

- **Delta Spec:** Each example file exports `run(deps)` taking injected dependencies (fake CDP edge) and returning the printed result; `manifest.json` is an array of `{id, block, kind, source}` with `block` the zero-based index of the fenced block in README.md. The unit test imports every example, executes `run` with fakes, reads README.md and the manifest, and asserts every block is listed and its source resolves (CLI lines are checked against the operation names and flags of the built help text constants in `host-flags.ts`). README command lines use the style recorded in `evidence/naming-decision.md` (`stealth-search search --provider duckduckgo --query ...`); the positional legacy form is not expressible (O2) and is noted once.

- **Invariants:** [inv:search-over-core] [inv:trace-namespace] [inv:typed-errors] [inv:greenfield] [inv:pnpm-only] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-examples]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-examples` runs every acceptance criterion below (red until the work is done); `--only search-examples.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-examples --only search-examples.N`, loaded from `scripts/guards/search_b.py`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-examples.1] examples/ holds at least one runnable TypeScript example per operation (all eleven operation names appear in the example files) and each example file exports a `run` function and cites ticket 8468f7b1.
- [search-examples.2] examples/manifest.json lists every README code block: its entry count equals the number of fenced code blocks in README.md, and each entry has {id, block, kind: ts|sh|text|json, source} where ts/sh entries point at an existing examples/ file or an operation name.
- [search-examples.3] Every `stealth-search` / `stealth-search-mcp` command line in README.md names a real operation (in the style of naming-decision.md) and only flags that exist in src/host-flags.ts or are properties of the SearchInput/verb inputs.
- [search-examples.4] A unit test src/test/unit/examples/ runs every example's `run` (against injected fakes) and verifies every README manifest entry; it cites ticket 8468f7b1 and [search-examples.4], imports no child_process, and `nx run stealth-search:test -- src/test/unit/examples` exits 0 (100% README examples).
- [search-examples.5] Only owned paths changed by [psm:search-examples] commits.

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/evidence/naming-decision.md", "entrypoint/stealth-search/src/host-flags.ts"]
mutates:    ["entrypoint/stealth-search/examples/", "entrypoint/stealth-search/src/test/unit/examples/", "entrypoint/stealth-search/README.md"]
```

---

## Contract Promise

Added: `examples/*`, `examples/manifest.json`, `src/test/unit/examples/*.spec.ts`. Modified: `README.md` code blocks. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-examples]`:

- [ ] After the examples and manifest — commit: `docs(stealth-search): runnable examples and manifest [psm:search-examples]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- No spawned process (ADR-0009). Examples never hard-code paths of this worktree.
- Parallel sibling: `search-usecases` (disjoint scope). `readme-rewrite` later keeps every manifest block intact or updates the manifest in the same commit.
