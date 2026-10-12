# mig-docs — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** mig-foundation · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-docs`
**Executor:** `refactoring-specialist` (sonnet/low) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** mig-cdp, mig-chrome-manager, mig-domains-storage, mig-capture-parsers, mig-queries (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

The runner's reference documentation travels with the code under `docs/reference/` with working links and no references to the retired nested package or to agent-search internals.

---

## Semantic Distillation

- **Primitive:** MIGRATE `/Users/nix/dev/ai/scratch/agent-browser/adhd/README.md`, `/Users/nix/dev/ai/scratch/agent-browser/adhd/docs/*.md`, `/Users/nix/dev/ai/scratch/agent-browser/adhd/cdp-connection/README.md`, `/Users/nix/dev/ai/scratch/agent-browser/docs/cdp/*.md` -> `entrypoint/stealth-browser/docs/reference/`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/adhd/docs/{capture,cdp,chrome-manager,parsers,storage}.md`; `/Users/nix/dev/ai/scratch/agent-browser/docs/cdp/*` (protocol overview, domains, monitoring, usage, target timing, history db).

- **Delta Spec:** Copy per `port-manifest.json` bucket `docs`; rewrite relative links; replace `@adhd/cdp-connection` import snippets with the new package paths (`@adhd/stealth-browser`). Do not invent claims: this is reference material, not marketing (marketing is the docs/readme states).

- **Invariants:** No file outside `docs/reference/` is written. [inv:source-untouched]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:mig-docs]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-docs` — runs every acceptance criterion below (red until the work is done); `--only mig-docs.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py mig-docs --only mig-docs.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [mig-docs.1] Every doc in the manifest (adhd/docs/*, adhd/README, cdp-connection README, docs/cdp/*) exists under docs/reference/ and is non-trivial.

- [mig-docs.2] Relative markdown links inside docs/reference resolve and none point at @adhd/cdp-connection or agent-search files.
---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/adhd/docs/", "/Users/nix/dev/ai/scratch/agent-browser/docs/cdp/"]
mutates:    ["entrypoint/stealth-browser/docs/reference/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/docs/reference/**`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:mig-docs]`:

- [ ] After the copy and link rewrite -- commit: `docs(stealth-browser): migrate reference docs [psm:mig-docs]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The doc-steward marketing run later owns `docs/` wholesale and may reorganize these; keep this state mechanical.
