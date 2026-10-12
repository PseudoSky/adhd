# mig-capture-parsers — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** mig-foundation · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-capture-parsers`
**Executor:** `refactoring-specialist` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** mig-chrome-manager, mig-domains-storage, mig-docs (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

The capture layer (`bans`, `dom`, `network`, barrel) and the DOM/XPath parsers exist in the new package. `parsers.ts` is the only file with third-party imports and relies on `deps-install`.

---

## Semantic Distillation

- **Primitive:** MIGRATE `/Users/nix/dev/ai/scratch/agent-browser/adhd/capture/*.ts` and `/Users/nix/dev/ai/scratch/agent-browser/adhd/parsers.ts` -> `entrypoint/stealth-browser/src/lib/capture/`, `entrypoint/stealth-browser/src/lib/parsers.ts`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/adhd/parsers.ts:17-26` (node-html-parser, @xmldom/xmldom, xpath), `/Users/nix/dev/ai/scratch/agent-browser/adhd/capture/dom.ts:149-206` Google-specific logic, `/Users/nix/dev/ai/scratch/agent-browser/adhd/capture/bans.ts:25` decideRetry.

- **Delta Spec:** Port every file listed for this bucket in `docs/plan/stealth-browser/scripts/port-manifest.json` (source `adhd/capture/*.ts, adhd/parsers.ts` -> destination under `entrypoint/stealth-browser/`). The port is BEHAVIOR-PRESERVING: copy, then adapt only (a) relative import specifiers to the new layout with `.js` extensions, (b) header comments that name the old repo layout. Every export of the source file must still be exported (guard compares export names) and each file must stay >= the manifest's `min_similarity` line-similar to its source (default 0.80). No `Runtime.evaluate`, no `--enable-automation`, no imports from agent-search, no committed `.js` twins. `capture/dom.ts` is carried verbatim but its header gets an `@deprecated` JSDoc line (Google-SERP walker; the source marks the root duplicate deprecated) so product can decide its fate at the hold point.

- **Invariants:** `parsers.ts` third-party imports are exactly the three declared packages. [inv:esm-js-specifiers] [inv:stealth] [ref:runner-port] Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:mig-capture-parsers]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-capture-parsers` — runs every acceptance criterion below (red until the work is done); `--only mig-capture-parsers.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py mig-capture-parsers --only mig-capture-parsers.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [mig-capture-parsers.1] Every manifest file exists, keeps every export, stays >=80% line-similar to the source, keeps its must-contain tokens.

- [mig-capture-parsers.2] No .ts import specifiers, no reach into agent-search, no Runtime.evaluate/--enable-automation; every relative import resolves.
---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/adhd/", "entrypoint/stealth-browser/src/lib/types.ts"]
mutates:    ["entrypoint/stealth-browser/src/lib/capture/", "entrypoint/stealth-browser/src/lib/parsers.ts"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/lib/capture/*.ts`, `entrypoint/stealth-browser/src/lib/parsers.ts`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:mig-capture-parsers]`:

- [ ] After capture compiles -- commit: `feat(stealth-browser): migrate capture [psm:mig-capture-parsers]`
- [ ] After parsers compile -- commit: `feat(stealth-browser): migrate parsers [psm:mig-capture-parsers]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- `capture/network.ts` has a duplicate at the agent-search root (`network-capture.ts`); migrate only `adhd/capture/network.ts`.
- Do not move search-engine-specific files (`search-dom.ts`, `search-challenge.ts`, `search-fetch.ts`): they stay in agent-search.
