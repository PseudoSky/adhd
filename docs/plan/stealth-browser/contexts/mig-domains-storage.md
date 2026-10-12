# mig-domains-storage — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** mig-cdp · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-domains-storage`
**Executor:** `refactoring-specialist` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** mig-chrome-manager, mig-capture-parsers, mig-docs (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

The typed CDP domain wrappers (`browser, network, page, system, target, transport` + barrel) and the Chrome profile storage readers (`bookmarks, cookies, history, profile, helpers` + barrel) exist in the new package.

---

## Semantic Distillation

- **Primitive:** MIGRATE `/Users/nix/dev/ai/scratch/agent-browser/adhd/{domains,storage}/*.ts` -> `entrypoint/stealth-browser/src/lib/{domains,storage}/`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/adhd/domains/index.ts` (CdpClient), `/Users/nix/dev/ai/scratch/agent-browser/adhd/storage/history.ts` (HistoryClient), `/Users/nix/dev/ai/scratch/agent-browser/adhd/storage/helpers.ts` (immutable DB open).

- **Delta Spec:** Port every file listed for this bucket in `docs/plan/stealth-browser/scripts/port-manifest.json` (source `adhd/domains/*.ts, adhd/storage/*.ts` -> destination under `entrypoint/stealth-browser/`). The port is BEHAVIOR-PRESERVING: copy, then adapt only (a) relative import specifiers to the new layout with `.js` extensions, (b) header comments that name the old repo layout. Every export of the source file must still be exported (guard compares export names) and each file must stay >= the manifest's `min_similarity` line-similar to its source (default 0.80). No `Runtime.evaluate`, no `--enable-automation`, no imports from agent-search, no committed `.js` twins.

- **Invariants:** Chrome databases are opened read-only/immutable; no write path is introduced. [inv:esm-js-specifiers] [inv:stealth] [ref:runner-port] Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:mig-domains-storage]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-domains-storage` — runs every acceptance criterion below (red until the work is done); `--only mig-domains-storage.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py mig-domains-storage --only mig-domains-storage.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

_No criteria yet._

---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/adhd/", "entrypoint/stealth-browser/src/lib/cdp/", "entrypoint/stealth-browser/src/lib/types.ts", "entrypoint/stealth-browser/src/lib/helpers.ts"]
mutates:    ["entrypoint/stealth-browser/src/lib/domains/", "entrypoint/stealth-browser/src/lib/storage/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/lib/domains/*.ts`, `entrypoint/stealth-browser/src/lib/storage/*.ts`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:mig-domains-storage]`:

- [ ] After domains compile -- commit `domains/`; after storage compiles -- commit `storage/` (one commit each, explicit paths): `feat(stealth-browser): migrate domains|storage [psm:mig-domains-storage]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Storage readers use `better-sqlite3` -- check the source import and add it to deps only if the source actually imports it (it is a workspace dependency elsewhere; if missing from package.json raise to the dispatcher, do not install yourself).
