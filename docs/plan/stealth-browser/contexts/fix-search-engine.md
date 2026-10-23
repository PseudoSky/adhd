# fix-search-engine — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** conform-search, conform-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-engine`
**Executor:** executor=typescript-pro tier=sonnet/high · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The DOM extraction is correct and has one walker: the pypi provider finds its URL, the Google SERP title fallback is gone with the single walker kept in the core, and the decision is recorded as reversible.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-search-engine.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- pypi: the provider's dom config never finds a URL because `findChild` searches descendants while the result container IS the anchor. Fix the lookup to test the container itself first; verify the description tag (SPAN vs p) against a real-shape fixture saved under test/fixtures/providers/pypi/ (capture it with a plain HTTP GET of the pypi search page, record the source in evidence); the spec drives the real provider dom config over the fixture and asserts url, title and description.

- Google SERP walker: the title fallback is partly dead because `getText` collapses whitespace so the `\s{2,}` split never fires. The original walker still lives in core `src/lib/capture/dom.ts` (OD-11). Provisional decision (the user's is pending): keep ONE walker, in core; search's `src/lib/dom.ts` delegates to it; delete the dead fallback. Create docs/plan/stealth-browser/OPEN-DECISIONS.md with an entry `OD-11 (provisional, reversible)` recording what was kept, what was deleted and how to restore the search-side walker from git history.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-search-engine]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-engine` runs every acceptance criterion below (red until the work is done); `--only fix-search-engine.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-search-engine --only fix-search-engine.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fix-search-engine.1] A spec under test/unit/providers cites [fix-search-engine.1] and drives the real pypi dom config over a real-shape fixture (`test/fixtures/providers/pypi/*.html`, anchor containers): titles carry `pypi`, `anchor`, `findChild`, `url` and `description`; the spec is green.

- [fix-search-engine.2] A spec under test/unit/engine cites [fix-search-engine.2] and walks a Google SERP fixture through the single walker: titles carry `title`, `single walker`, `whitespace` and `google`; the dead `\s{2,}` title fallback no longer exists in search or core dom.ts.
- [fix-search-engine.3] Exactly one SERP walker remains: core `src/lib/capture/dom.ts` holds it, search `src/lib/dom.ts` has no second copy of the walker, and docs/plan/stealth-browser/OPEN-DECISIONS.md has an `OD-11` entry marked provisional and reversible.
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/lib/dom.ts", "entrypoint/stealth-search/src/lib/providers.ts", "entrypoint/stealth-search/src/lib/utils.ts", "entrypoint/stealth-search/src/lib/network.ts", "entrypoint/stealth-search/src/lib/challenge.ts", "entrypoint/stealth-search/test/unit/engine/", "entrypoint/stealth-search/test/unit/providers/", "entrypoint/stealth-search/test/fixtures/engine/", "entrypoint/stealth-search/test/fixtures/providers/", "entrypoint/stealth-search/test/helpers/engine/", "packages/stealth/stealth-core-browser/src/lib/capture/dom.ts", "packages/stealth/stealth-core-browser/test/unit/capture-parsers/dom.spec.ts", "docs/plan/stealth-browser/OPEN-DECISIONS.md", "docs/plan/stealth-browser/evidence/fix-search-engine.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-search-engine.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-search-engine]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; OD-11 provisional resolution
