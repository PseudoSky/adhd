# prod-examples — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** tracing-plugin · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-examples`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])
**Parallel with:** tests-unit-surface (disjoint owned paths, proven by `check-disjoint.py`)

**Origin:** inserted by `productization-hold` from `PRODUCT-REVIEW.md`; criteria carry the review's PA ids in their text.

---

## Goal

A consumer has a working quickstart for each surface: a typechecked library example, a CLI transcript and a Claude Code MCP config snippet, all on an explicit non-default port. (Source: PRODUCT-REVIEW.md P7.)

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/examples/{library.ts,cli.md,mcp-config.json}` and `entrypoint/stealth-browser/src/test/unit/examples/`; MODIFY `entrypoint/stealth-browser/tsconfig.spec.json` (include `examples/`).

- **Reference Pattern:** `entrypoint/stealth-browser/package.json` (bin names, exports), `entrypoint/stealth-browser/src/index.ts`, `demo/DEMO.md`, sibling `entrypoint/dispatch-cli` tsconfig.spec.json.

- **Delta Spec:** `library.ts` imports from the package and calls `chromeStatus` / `launchChrome` / `getPageContext` on `port: 9333` (never 9222). `cli.md` shows `stealth-browser <verb> --port 9333` transcripts using the verb style recorded in `evidence/naming-decision.md`. `mcp-config.json` is a Claude Code `mcpServers` snippet whose command runs the `stealth-browser-mcp` bin with `--port 9333`. A unit spec asserts the JSON parses, the bin name matches package.json and no example uses 9222.

- **Invariants:** [inv:live-chrome] (examples never name 9222) [inv:tests-cite] [inv:unit-purity] [inv:esm-js-specifiers]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:prod-examples]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-examples` — runs every acceptance criterion below (red until the work is done); `--only prod-examples.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py prod-examples --only prod-examples.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [prod-examples.1] (PA7.1) examples/library.ts, examples/cli.md and examples/mcp-config.json exist and are non-empty.

- [prod-examples.2] (PA7.2) tsconfig.spec.json includes examples/ and `nx run stealth-browser:typecheck-spec` exits 0 with examples/library.ts importing the package.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/", "entrypoint/stealth-browser/bin/", "entrypoint/stealth-browser/package.json"]
mutates:    ["entrypoint/stealth-browser/examples/", "entrypoint/stealth-browser/src/test/unit/examples/", "entrypoint/stealth-browser/tsconfig.spec.json"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/examples/*`, `entrypoint/stealth-browser/src/test/unit/examples/*.spec.ts`. Modified: `entrypoint/stealth-browser/tsconfig.spec.json`. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:prod-examples]`:

- [ ] After the examples and their spec -- commit: `docs(stealth-browser): library, CLI and MCP examples [psm:prod-examples]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- `tests-e2e` depends on this state so the examples are settled before the e2e lane and before `tracing-namespace-proof` flips `src/tracing.ts` (typecheck-spec must not race that mutation).
