# prod-examples — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** core-seam, prod-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-examples`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

A user can copy a working example for every public verb and every namespace of the core library, each tied to a real use case, typechecked and exercised by the use-case suites, and the core README is built from them (user decision: implement the README examples and genuine use cases for users). CLI transcripts and MCP configuration snippets belong to `@adhd/stealth-search` (`search-examples`).

---

## Semantic Distillation

- **Primitive:** CREATE `packages/stealth/stealth-core-browser/examples/verbs/<verb>.ts` (six), `examples/namespaces/<namespace>.ts` (seven: cdp, storage, capture, parsers, chromeManager, recording, lifecycle), `src/test/unit/examples/`; MODIFY `tsconfig.spec.json` (include `examples/`).

- **Reference Pattern:** `USE_CASES.md` (genuine scenarios), `packages/stealth/stealth-core-browser/src/index.ts` (root namespaces and verbs), `src/errors.ts` (examples show handling a typed error), `src/lib/managers.ts` (the lifecycle example configures the seam).

- **Delta Spec:** Each `.ts` example opens with a `Scenario:` header naming the real task it solves, imports the package ROOT only, uses an explicit non-9222 port (e.g. 9333), exports `run(options)` so a suite can drive it, and demonstrates its verb/namespace members (a namespace example uses at least three members). A spec under `src/test/unit/examples/` imports and runs every example against the in-process fake CDP server; the README and docs states consume these files verbatim.

- **Invariants:** [inv:live-chrome] (no 9222) [inv:tests-cite] [inv:unit-purity] [inv:esm-js-specifiers] [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:prod-examples]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-examples` — runs every acceptance criterion below (red until the work is done); `--only prod-examples.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py prod-examples --only prod-examples.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [prod-examples.1] (PA7.1, widened) examples/ holds one runnable TypeScript example per public verb (examples/verbs/<verb>.ts for the six verbs) and per root namespace (examples/namespaces/<namespace>.ts for cdp, storage, capture, parsers, chromeManager, recording, lifecycle), all non-empty; each .ts example opens with a `Scenario:` header naming the real user task it solves and exports `run(options)`.
- [prod-examples.2] (PA7.2) tsconfig.spec.json includes examples/, every .ts example imports the package ROOT only (`@adhd/stealth-core-browser` or `../../src/index.js`, never a subpath or a src/lib path), and `nx run stealth-core-browser:typecheck-spec` exits 0.
- [prod-examples.4] (PA7.4) Every example (all .ts) uses an explicit non-9222 port and never the default 9222.
- [prod-examples.5] Coverage: every verb example calls its own verb and no other (examples/verbs/<verb>.ts contains `<verb>(` ), and every namespace example uses at least three members of its namespace (`<namespace>.<member>`); only owned paths changed by [psm:prod-examples] commits.
- [prod-examples.6] The examples are exercised, not just typechecked: a spec under src/test/unit/examples/ imports every examples/verbs and examples/namespaces file and runs its `run()` against the in-process fake CDP server (no live Chrome), citing ticket 8468f7b1, a valid prod-examples.N id and PA7.2 / PA7.4.

---

## Reservations

```text
read_only:  ["packages/stealth/stealth-core-browser/src/index.ts", "packages/stealth/stealth-core-browser/package.json"]
mutates:    ["packages/stealth/stealth-core-browser/examples/", "packages/stealth/stealth-core-browser/src/test/unit/examples/", "packages/stealth/stealth-core-browser/tsconfig.spec.json"]
```

---

## Contract Promise

Added: `examples/**`, `src/test/unit/examples/**`. Modified: `tsconfig.spec.json`. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:prod-examples]`:

- [ ] After the verb and namespace examples — commit: `docs(stealth-core-browser): runnable example per verb and namespace [psm:prod-examples]`
- [ ] After the examples spec — commit: `test(stealth-core-browser): run every example in the unit lane [psm:prod-examples]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- `prod-errors` is an ancestor so examples can show real error handling.
- `tests-use-cases` runs every example again inside a scenario; keep `run()` side-effect free beyond the port it is given.
