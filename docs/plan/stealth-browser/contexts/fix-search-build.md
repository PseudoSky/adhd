# fix-search-build — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** search-mcp-iserror · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-build`
**Executor:** executor=typescript-pro tier=sonnet/high · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The operations cache is baked at build time (I-35), a cold start stays inside the 15 s limit of search-hosts.18, and the published manifest carries no `nx` key.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-search-build.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- I-35: the operations cache is written at the first run (~13 s cold against the 15 s limit). Generate it during the build (a `build-bin` step or a script under `scripts/`) and ship it in dist; the host reads the baked cache and falls back to extraction with a typed error path only when the baked file is stale (key mismatch). Unit spec: a stale and a fresh baked cache, asserting extraction runs only for the stale one.

- The `nx` key of `package.json` must not appear in the published manifest: strip it in the publish/dist-manifest step (follow what main's `dist-manifest` target does) and assert it on the manifest that `nx run stealth-search:dist-manifest` (or the pack) produces.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-search-build]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-build` runs every acceptance criterion below (red until the work is done); `--only fix-search-build.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-search-build --only fix-search-build.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fix-search-build.1] A spec under test/unit/build cites [fix-search-build.1] and proves the baked cache: a fresh cache avoids extraction, a stale key re-extracts: titles carry `I-35`, `baked`, `stale`, `cold`; and the build produces the cache file in dist.

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/package.json", "entrypoint/stealth-search/project.json", "entrypoint/stealth-search/vite.config.ts", "entrypoint/stealth-search/tsconfig.build-bin.json", "entrypoint/stealth-search/bin/", "entrypoint/stealth-search/scripts/", "entrypoint/stealth-search/src/server.ts", "entrypoint/stealth-search/test/unit/build/", "docs/plan/stealth-browser/evidence/fix-search-build.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-search-build.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-search-build]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; I-35
